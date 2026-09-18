import { toUserMessage } from '@/utils/toUserMessage';
import { Input } from '@/components/ui/input';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { Colors } from '@/constants/Colors';
import { Type } from '@/ui/tokens';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Stack, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
// @ts-ignore
import { Organization, Team, User } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import { uploadFile } from '@/api/upload';
import { PlaceSuggestion } from '@/api/geocoding';
import LocationPicker from '@/components/LocationPicker';
import { httpPost } from '@/api/http';
import { ZipCodeMapPreview } from '@/components/ZipCodeMapPreview';
import { useAuth } from '@/context/AuthProvider';
import { useOnboarding } from '@/context/OnboardingContext';
import { useOrganizationSearch } from '@/hooks/useOrganizationSearch';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { getPostAuthRouteDecision } from '@/utils/appRouteDecisions';
import { pickerMediaTypesProp } from '@/utils/picker';
import { getFreshPostAuthState } from '@/utils/postMutationAuth';
import { showUploadErrorAlert } from '@/utils/uploadErrorAlert';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import OnboardingLayout from './components/OnboardingLayout';
import { createStyles } from '@/styles/onboarding/step-3-league.styles';

const COACH_ORG_TYPES = [
  'school',
  'club',
  'league',
  'university',
  'college',
  'professional',
] as const;

function isCoachOrgType(value: unknown): value is (typeof COACH_ORG_TYPES)[number] {
  return (
    typeof value === 'string' && COACH_ORG_TYPES.includes(value as (typeof COACH_ORG_TYPES)[number])
  );
}

function normalizeDateString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function Step3League() {
  const router = useRouter();
  const pathname = usePathname();
  const colorScheme = useColorScheme() ?? 'light';
  const isDark = colorScheme === 'dark';
  const theme = Colors[colorScheme];
  const { user, markOnboardingCompleteLocally, checkAuth, registerPushToken } = useAuth();
  const { state: ob, setState: setOB } = useOnboarding();
  const accountState = String(user?.account_state || '').trim();
  const canonicalStep3Route = user ? getPostAuthRouteDecision(user as any).route : null;
  const canEnterStep3FromServer =
    accountState === 'coach_application_required' ||
    accountState === 'coach_agreement_required' ||
    accountState === 'coach_final_setup_required';

  // Prerequisite guard: steps 1-2 must be completed before step-3
  useEffect(() => {
    if (canEnterStep3FromServer) {
      setOB(prev => {
        const nextRole = prev.role || 'coach';
        const nextDob =
          prev.dob ||
          (typeof user?.dob === 'string' ? user.dob : undefined) ||
          (typeof user?.date_of_birth === 'string' ? user.date_of_birth : undefined);
        const nextZip =
          prev.zip ||
          prev.zip_code ||
          (typeof user?.zip_code === 'string' ? user.zip_code : undefined) ||
          (typeof user?.preferences?.zip_code === 'string' ? user.preferences.zip_code : undefined);

        const alreadySeeded =
          prev.role === nextRole &&
          prev.step_2_visited === true &&
          (nextDob ? prev.dob === nextDob : true) &&
          (nextZip ? prev.zip === nextZip || prev.zip_code === nextZip : true);

        if (alreadySeeded) return prev;
        return {
          ...prev,
          role: nextRole,
          step_2_visited: true,
          ...(nextDob ? { dob: nextDob } : {}),
          ...(nextZip ? { zip: nextZip, zip_code: nextZip } : {}),
        };
      });
      return;
    }

    if (!ob.role) {
      if (__DEV__) console.warn('[step-3-league] No role set — redirecting to step-1');
      router.replace('/onboarding/step-1-role');
    } else if (!ob.step_2_visited) {
      if (__DEV__) console.warn('[step-3-league] Step-2 not completed — redirecting');
      router.replace('/onboarding/step-2-basic');
    }
  }, [
    canEnterStep3FromServer,
    ob.role,
    ob.step_2_visited,
    router,
    setOB,
    user?.date_of_birth,
    user?.dob,
    user?.preferences?.zip_code,
    user?.zip_code,
  ]);

  // Form state
  const [orgName, setOrgName] = useState('');
  const [location, setLocation] = useState('');
  const [orgType, setOrgType] = useState<
    'school' | 'club' | 'league' | 'university' | 'college' | 'professional' | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [existingTeam, setExistingTeam] = useState<any>(null);
  const [existingOrg, setExistingOrg] = useState<any>(null);
  const [checking, setChecking] = useState(true);

  // Search/Join state
  const initialZip = ob.zip || ob.zip_code || '';
  const [showSearch, setShowSearch] = useState(!!initialZip);
  const [searchZip, setSearchZip] = useState(initialZip);
  const {
    organizations: nearbyOrgs,
    loading: searching,
    search: searchOrganizations,
    clear: clearOrganizations,
  } = useOrganizationSearch(false);
  const [hasSearchedNearby, setHasSearchedNearby] = useState(!!initialZip);
  const [requestingJoin, setRequestingJoin] = useState(false);
  const [joinMessage, setJoinMessage] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<any>(null);
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSuggestion | null>(null);
  const [selectedPlaceZip, setSelectedPlaceZip] = useState<string | null>(null);
  const [_emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [isFinalCoachSetup, setIsFinalCoachSetup] = useState(false);
  const [submittedApplicationName, setSubmittedApplicationName] = useState<string | null>(null);
  const [duplicateOrg, setDuplicateOrg] = useState<{
    id: string;
    name: string;
    location?: string;
    sport?: string;
  } | null>(null);
  const dupCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [supportingDocumentUri, setSupportingDocumentUri] = useState<string | null>(null);
  const [supportingDocumentUrl, setSupportingDocumentUrl] = useState<string | null>(null);
  const [supportingDocumentName, setSupportingDocumentName] = useState<string | null>(null);
  const [supportingDocumentMimeType, setSupportingDocumentMimeType] = useState<string | null>(null);
  const [_uploadingDocument, setUploadingDocument] = useState(false);

  const styles = useMemo(() => createStyles(colorScheme), [colorScheme]);
  const canSearchForExistingOrganization = !isFinalCoachSetup;

  // Hydrate the shared step-3 screen from canonical auth state. This file is
  // mounted for both /coach-application and /step-3-league, so route mode
  // must follow server-directed routing rather than a second local state machine.
  useEffect(() => {
    setEmailVerified(user?.email_verified ?? null);

    if (
      canonicalStep3Route &&
      canonicalStep3Route !== pathname &&
      (canonicalStep3Route === '/onboarding/coach-application' ||
        canonicalStep3Route === '/onboarding/step-3-league' ||
        canonicalStep3Route === '/onboarding/coach-agreement')
    ) {
      router.replace(canonicalStep3Route as any);
      return;
    }

    const finalSetupRequired = canonicalStep3Route === '/onboarding/step-3-league';
    const coachApplication = user?.coach_application || null;

    setIsFinalCoachSetup(finalSetupRequired);
    setSubmittedApplicationName(coachApplication?.organization_name || null);
    if (finalSetupRequired) {
      setShowSearch(false);
      clearOrganizations();
      setHasSearchedNearby(false);
      setSelectedOrg(null);
      setShowOrgDropdown(false);
      if (coachApplication?.organization_name && !orgName.trim()) {
        setOrgName(coachApplication.organization_name);
      }
      if (coachApplication?.location && !location.trim()) {
        setLocation(coachApplication.location);
      }
      if (coachApplication?.org_type && !orgType && isCoachOrgType(coachApplication.org_type)) {
        setOrgType(coachApplication.org_type);
      }
      if (coachApplication?.supporting_document_url && !supportingDocumentUrl) {
        setSupportingDocumentUrl(coachApplication.supporting_document_url);
      }
      if (coachApplication?.zip_code && !searchZip.trim()) {
        setSearchZip(coachApplication.zip_code);
      }
    }
  }, [
    canonicalStep3Route,
    clearOrganizations,
    location,
    orgName,
    orgType,
    pathname,
    router,
    searchZip,
    supportingDocumentUrl,
    user,
  ]);

  // Check if user already has a team or organization in the database
  useEffect(() => {
    void (async () => {
      setChecking(true);
      try {
        // Check for existing managed teams
        const teams = await Team.managed();
        if (teams && teams.length > 0) {
          const firstTeam = teams[0];
          const teamOrgId = firstTeam?.organization_id || firstTeam?.organization?.id || null;
          const teamOrgName = firstTeam?.organization_name || firstTeam?.organization?.name || null;
          setExistingTeam(firstTeam);
          setAlreadyExists(true);
          // Update onboarding state with existing team
          setOB(prev => ({
            ...prev,
            team_id: firstTeam.id,
            team_name: firstTeam.name,
            ...(teamOrgId ? { organization_id: teamOrgId } : {}),
            ...(teamOrgName ? { organization_name: teamOrgName } : {}),
          }));

          // Never auto-skip — let user see and confirm their organization info
        } else {
          // Check for existing organizations that the user can manage
          const summaries = await Organization.reviewSummaries();
          if (summaries && summaries.length > 0) {
            const firstOrg = summaries[0]?.organization;
            if (!firstOrg?.id) {
              return;
            }
            setExistingOrg(firstOrg);
            setOrgName(firstOrg.name || '');
            setAlreadyExists(true);
            setOB(prev => ({
              ...prev,
              organization_id: firstOrg.id,
              organization_name: firstOrg.name,
            }));

            // Never auto-skip — let user confirm org selection
          }
        }
      } catch {
        Alert.alert('Error', 'Unable to check existing organizations. Please try again.');
      } finally {
        setChecking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  useEffect(() => {
    if (ob.organization_name && !existingOrg) setOrgName(ob.organization_name);
    const aff = ob.affiliation as string;
    if (aff === 'high_school') setOrgType('school');
    else if (aff === 'university') setOrgType('university');
    else if (aff === 'professional') setOrgType('professional');
    else if (aff === 'club' || aff === 'youth') setOrgType('club');
    else if (aff === 'league') setOrgType('league');
    // Do NOT auto-set alreadyExists from stale AsyncStorage state.
    // Only the async DB check (Team.managed / Organization.mine) should set alreadyExists.
  }, [
    alreadyExists,
    existingOrg,
    ob.affiliation,
    ob.organization_id,
    ob.team_id,
    ob.organization_name,
  ]);

  // Determine what type of page to create based on plan
  const pageConfig = useMemo(() => {
    if (alreadyExists) {
      const displayName =
        existingTeam?.name || existingOrg?.name || ob.team_name || ob.organization_name;
      return {
        type: existingTeam || ob.team_id ? 'team' : 'organization',
        title: existingTeam || ob.team_id ? 'Team Already Created' : 'Organization Already Created',
        subtitle:
          existingTeam || ob.team_id
            ? `Your team "${displayName}" is ready to go!`
            : `Organization "${displayName}" is ready to go!`,
        description:
          existingTeam || ob.team_id
            ? 'Team page has been created. Continue through setup, then manage roster and staff invites from your team tools.'
            : 'Organization page has been created. Continue through setup, then invite managers and members from organization tools.',
        alreadyExists: true,
      };
    }

    if (isFinalCoachSetup) {
      return {
        type: 'organization',
        title: 'Create Organization',
        subtitle: submittedApplicationName
          ? `Approved to set up ${submittedApplicationName}`
          : 'Create your approved organization',
        description:
          'Your application was approved. Finish coach setup by creating the real organization page now.',
        alreadyExists: false,
      };
    }

    // New coach applicants submit an application first.
    return {
      type: 'organization',
      title: 'Submit Coach Application',
      subtitle: 'Tell VarsityHub about the organization you want to create',
      description:
        'This information is reviewed as your application. VarsityHub will not create the organization until you are approved.',
      alreadyExists: false,
    };
  }, [
    alreadyExists,
    existingOrg,
    existingTeam,
    isFinalCoachSetup,
    ob.organization_name,
    ob.team_id,
    ob.team_name,
    submittedApplicationName,
  ]);

  const canContinue = useMemo(() => {
    if (saving) return false;

    // If team/org already exists or join request was submitted, user can continue
    if (alreadyExists || ob.join_request_pending) return true;

    // All coaches need organization fields; location may be typed or autocomplete-selected
    // Supporting document (file/image) is mandatory when creating new organization
    const hasRequiredFields =
      orgName.trim().length > 0 && !!orgType && (!!selectedPlace || location.trim().length >= 2);
    const hasSupportingDoc = !!supportingDocumentUrl || !!supportingDocumentUri;
    return hasRequiredFields && hasSupportingDoc;
  }, [
    orgName,
    orgType,
    saving,
    alreadyExists,
    ob.join_request_pending,
    selectedPlace,
    location,
    supportingDocumentUrl,
    supportingDocumentUri,
  ]);

  // Format organization type for display (capitalize & friendly term mapping)
  const formatOrgType = (raw?: string) => {
    if (!raw) return '';
    const normalized = raw.toLowerCase();
    const map: Record<string, string> = {
      school: 'School',
      club: 'Club',
      league: 'League',
      university: 'University',
      college: 'College',
      pro: 'Professional',
      professional: 'Professional',
    };
    return map[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
  };

  // Search for nearby organizations (auto-invoked as user types)
  const executeNearbySearch = useCallback(
    (query?: string) => {
      const term = (query ?? searchZip).trim();
      if (!term) {
        setHasSearchedNearby(false);
        clearOrganizations();
        return;
      }
      setHasSearchedNearby(true);
      searchOrganizations({
        query: term,
        limit: 20,
        mode: 'nearby',
        orgType: orgType || undefined,
      }).catch(() => {});
    },
    [clearOrganizations, orgType, searchOrganizations, searchZip]
  );

  const handleSearchInput = useCallback(
    (text: string) => {
      setSearchZip(text);
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      if (text.trim().length >= 2) {
        searchTimerRef.current = setTimeout(() => {
          void executeNearbySearch(text);
        }, 400);
      } else {
        setHasSearchedNearby(false);
        clearOrganizations();
      }
    },
    [clearOrganizations, executeNearbySearch]
  );

  // Auto-search for nearby orgs when step loads with a zip code from Step 2
  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (initialZip && !didAutoSearch.current) {
      didAutoSearch.current = true;
      void executeNearbySearch(initialZip);
    }
  }, [initialZip, executeNearbySearch]);

  const handleLocationSelect = useCallback(
    ({
      address,
      placeId,
      postalCode,
    }: {
      address: string;
      placeId?: string;
      latitude?: number;
      longitude?: number;
      postalCode?: string;
    }) => {
      setLocation(address);
      if (placeId) {
        setSelectedPlace({ description: address, place_id: placeId });
        const normalizedZip =
          postalCode?.slice(0, 5) || address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5);
        if (normalizedZip) {
          setSelectedPlaceZip(normalizedZip);
          setSearchZip(normalizedZip);
        }
        void (async () => {
          try {
            const zip = normalizedZip || undefined;
            const res = await httpPost('/organizations/check-duplicate', {
              name: orgName.trim(),
              zip_code: zip,
            });
            if (res && (res as any).exists && (res as any).organization) {
              setDuplicateOrg((res as any).organization);
            } else {
              setDuplicateOrg(null);
            }
          } catch {
            setDuplicateOrg(null);
          }
        })();
      } else {
        setSelectedPlace(null);
        setSelectedPlaceZip(null);
        setDuplicateOrg(null);
      }
    },
    [setSearchZip, orgName]
  );

  // Debounced duplicate check when org name changes
  const handleOrgNameChange = useCallback(
    (text: string) => {
      setOrgName(text);
      if (dupCheckTimerRef.current) {
        clearTimeout(dupCheckTimerRef.current);
      }
      if (text.trim().length >= 3) {
        dupCheckTimerRef.current = setTimeout(async () => {
          try {
            const zip = selectedPlaceZip || searchZip.trim() || undefined;
            const res = await httpPost('/organizations/check-duplicate', {
              name: text.trim(),
              zip_code: zip,
            });
            if (res && (res as any).exists && (res as any).organization) {
              setDuplicateOrg((res as any).organization);
            } else {
              setDuplicateOrg(null);
            }
          } catch {
            setDuplicateOrg(null);
          }
        }, 800);
      } else {
        setDuplicateOrg(null);
      }
    },
    [selectedPlaceZip, searchZip]
  );

  // Cleanup timers on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      if (dupCheckTimerRef.current) {
        clearTimeout(dupCheckTimerRef.current);
        dupCheckTimerRef.current = null;
      }
    };
  }, []);

  // Request to join an organization
  const requestToJoin = async (org: any) => {
    captureBreadcrumb('Join organization modal opened', 'onboarding.step3', {
      org_type: org?.org_type || orgType || 'unknown',
    });
    setSelectedOrg(org);
    setRequestingJoin(true);
  };

  const submitJoinRequest = async () => {
    if (!selectedOrg) return;

    setSaving(true);
    captureBreadcrumb('Join organization request started', 'onboarding.step3', {
      org_type: selectedOrg.org_type || orgType || 'unknown',
      has_message: !!joinMessage.trim(),
    });
    try {
      await httpPost('/organizations/join-requests', {
        organization_id: selectedOrg.id,
        message: joinMessage.trim() || undefined,
      });

      // Save pending status to local context — don't complete onboarding yet.
      // The user must press Continue to proceed (onContinue handles completeOnboarding).
      setOB(prev => ({
        ...prev,
        organization_id: selectedOrg.id,
        organization_name: selectedOrg.name,
        join_request_pending: true,
        step_3_visited: true,
      }));

      // Persist org_id + join_request_pending so state survives app restarts.
      // v1.0.3: previously only org_id/name were persisted — join_request_pending
      // lived only in local onboarding context, so a force-close after this
      // point lost the pending flag and users could re-submit the same join
      // request on next launch (dup risk). Persist the flag to the server
      // preferences here so /me reliably reflects the waiting state.
      await User.updatePreferences({
        organization_id: selectedOrg.id,
        organization_name: selectedOrg.name,
        join_request_pending: true,
      }).catch(() => {});

      // v1.0.2 pass 5 fix: wording now matches the new flow (waiting screen, not main app).
      Alert.alert(
        'Request Sent!',
        `Your request to join "${selectedOrg.name}" has been sent. You'll see a waiting screen while the organization admin reviews your request, then you'll be walked through the coach agreement and setup.`,
        [{ text: 'Continue' }]
      );
      captureBreadcrumb('Join organization request succeeded', 'onboarding.step3', {
        org_type: selectedOrg.org_type || orgType || 'unknown',
      });
    } catch (error: any) {
      captureBreadcrumb(
        'Join organization request failed',
        'onboarding.step3',
        {
          org_type: selectedOrg.org_type || orgType || 'unknown',
        },
        'warning'
      );
      captureException(typeof error === 'string' ? new Error(error) : error, {
        tags: { context: 'onboarding-step-3-join-request' },
      });
      Alert.alert('Request Failed', toUserMessage(error, 'Failed to send join request'));
    } finally {
      setSaving(false);
      setRequestingJoin(false);
      setJoinMessage('');
      setSelectedOrg(null);
    }
  };

  const routeFromDecision = useCallback(
    (
      route: string,
      options?: {
        organizationId?: string;
        organizationName?: string;
        agreementRedirect?: 'organization' | 'create-team';
      }
    ) => {
      if (route === '/onboarding/pending-approval') {
        router.replace({
          pathname: route,
          params: {
            leagueName: options?.organizationName || 'this organization',
            ownerName: 'the organization owner',
          },
        } as any);
        return;
      }

      if (route === '/onboarding/league-pending-approval') {
        router.replace({
          pathname: route,
          params: {
            ...(options?.organizationName ? { leagueName: options.organizationName } : {}),
            ...(options?.organizationId ? { orgId: options.organizationId } : {}),
          },
        } as any);
        return;
      }

      if (route === '/onboarding/coach-agreement') {
        router.replace({
          pathname: route,
          params: {
            redirect: options?.agreementRedirect || 'organization',
          },
        } as any);
        return;
      }

      router.replace(route as any);
    },
    [router]
  );

  const buildCoachCompletionPayload = useCallback(
    (patch?: {
      organizationId?: string;
      organizationName?: string;
      joinRequestPending?: boolean;
    }) => ({
      role: 'coach' as const,
      proceeding_as_fan: false,
      username: user?.username || ob.username,
      dob:
        normalizeDateString(user?.dob) ||
        normalizeDateString((user as any)?.date_of_birth)?.slice(0, 10) ||
        ob.dob,
      zip_code:
        normalizeDateString(user?.zip_code) ||
        normalizeDateString(user?.preferences?.zip_code) ||
        ob.zip_code ||
        ob.zip,
      affiliation:
        normalizeDateString(
          (user?.preferences as Record<string, unknown> | undefined)?.affiliation
        ) || ob.affiliation,
      organization_id: patch?.organizationId || undefined,
      organization_name: patch?.organizationName || undefined,
      join_request_pending: patch?.joinRequestPending,
    }),
    [ob.affiliation, ob.dob, ob.username, ob.zip, ob.zip_code, user]
  );

  const onContinue = async () => {
    if (!canContinue || saving) return;

    setSaving(true);
    captureBreadcrumb('Onboarding step 3 submit started', 'onboarding.step3', {
      mode:
        alreadyExists || ob.join_request_pending
          ? 'existing-or-pending'
          : showSearch
            ? 'search'
            : 'create',
      org_type:
        orgType || existingOrg?.org_type || existingTeam?.organization?.org_type || 'unknown',
      has_supporting_doc: !!supportingDocumentUrl || !!supportingDocumentUri,
    });
    try {
      // If team/org already exists or join request pending, complete onboarding
      if (alreadyExists || ob.join_request_pending) {
        setOB(prev => ({ ...prev, step_3_visited: true }));
        const resolvedOrgId = String(
          ob.organization_id ||
            existingTeam?.organization_id ||
            existingTeam?.organization?.id ||
            existingOrg?.id ||
            ''
        );
        const resolvedOrgName =
          ob.organization_name || existingTeam?.organization_name || existingOrg?.name || '';
        const isPendingJoin = !!ob.join_request_pending;

        if (resolvedOrgId || resolvedOrgName) {
          await User.updatePreferences({
            ...(resolvedOrgId ? { organization_id: resolvedOrgId } : {}),
            ...(resolvedOrgName ? { organization_name: resolvedOrgName } : {}),
            ...(isPendingJoin ? { join_request_pending: true } : {}),
          }).catch(() => {});
        }

        if (!isPendingJoin) {
          try {
            await User.completeOnboarding(
              buildCoachCompletionPayload({
                organizationId: resolvedOrgId || undefined,
                organizationName: resolvedOrgName || undefined,
              })
            );
            await markOnboardingCompleteLocally();
            registerPushToken().catch(() => {});
          } catch (err) {
            if (__DEV__) console.warn('[step-3] Failed to complete onboarding (existing):', err);
          }
        }
        const authUser = (await checkAuth().catch(() => null)) ?? user;
        const nextDecision = getPostAuthRouteDecision(authUser);
        captureBreadcrumb('Onboarding step 3 completed', 'onboarding.step3', {
          mode: isPendingJoin ? 'pending-join' : 'existing-org',
          next: nextDecision.route,
        });
        routeFromDecision(nextDecision.route, {
          organizationId: resolvedOrgId || undefined,
          organizationName: resolvedOrgName || undefined,
          agreementRedirect: 'organization',
        });
        return;
      }

      // Upload supporting document if we have a local file
      let docUrl = supportingDocumentUrl;

      if (!docUrl && supportingDocumentUri) {
        setUploadingDocument(true);
        captureBreadcrumb('Supporting document upload started', 'onboarding.step3', {
          file_type: supportingDocumentName?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image',
        });
        try {
          const nameHasPdf = supportingDocumentName?.toLowerCase().endsWith('.pdf');
          const mimeType =
            supportingDocumentMimeType || (nameHasPdf ? 'application/pdf' : 'image/jpeg');
          const isPdf = mimeType === 'application/pdf' || nameHasPdf === true;
          const fileName =
            supportingDocumentName || (isPdf ? 'supporting-doc.pdf' : 'supporting-doc.jpg');
          const result = await uploadFile(
            getApiBaseUrl(),
            supportingDocumentUri,
            fileName,
            mimeType,
            {
              formFields: {
                onboarding: true,
                upload_context: 'organization_supporting_document',
              },
            }
          );
          docUrl =
            result?.url ||
            result?.secure_url ||
            result?.path ||
            (typeof result === 'string' ? result : null);
          if (docUrl) setSupportingDocumentUrl(docUrl);
          captureBreadcrumb('Supporting document upload succeeded', 'onboarding.step3', {
            file_type: supportingDocumentName?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image',
          });
        } catch (uploadErr: any) {
          captureBreadcrumb(
            'Supporting document upload failed',
            'onboarding.step3',
            {
              file_type: supportingDocumentName?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image',
            },
            'warning'
          );
          captureException(typeof uploadErr === 'string' ? new Error(uploadErr) : uploadErr, {
            tags: { context: 'onboarding-step-3-supporting-document-upload' },
          });
          showUploadErrorAlert(uploadErr, {
            fallbackTitle: 'Upload Failed',
            fallbackMessage: 'Could not upload supporting document. Please try again.',
            logTag: 'onboarding-step-3-supporting-document-upload',
          });
          setSaving(false);
          setUploadingDocument(false);
          return;
        }
        setUploadingDocument(false);
      }
      if (!docUrl) {
        Alert.alert(
          'Supporting Document Required',
          'Please upload a file or image (e.g., school letterhead, registration) to verify your organization.'
        );
        setSaving(false);
        return;
      }

      const locationLabel = selectedPlace?.description || location.trim();
      if (!isFinalCoachSetup) {
        const applicationPayload: any = {
          organization_name: orgName.trim(),
          org_type: orgType || undefined,
          location: locationLabel || undefined,
          zip_code: selectedPlaceZip || searchZip.trim() || undefined,
          place_id: selectedPlace?.place_id || undefined,
          supporting_document_url: docUrl,
        };

        const submissionResult = await httpPost('/auth/coach-applications', applicationPayload);
        setOB(prev => ({
          ...prev,
          organization_name: orgName.trim(),
          organization_place_id: selectedPlace?.place_id ?? null,
          organization_location: locationLabel || null,
          step_3_visited: true,
        }));
        const authUser = (await checkAuth().catch(() => null)) ?? submissionResult?.user ?? user;
        const nextDecision = getPostAuthRouteDecision(authUser);
        captureBreadcrumb('Onboarding step 3 completed', 'onboarding.step3', {
          mode: 'submit-application',
          next: nextDecision.route,
        });
        routeFromDecision(nextDecision.route, {
          organizationName: orgName.trim(),
          agreementRedirect: 'organization',
        });
        return;
      }

      // Approved coach final setup: create the real organization now.
      const payload: any = {
        name: orgName.trim(),
        org_type: orgType,
        location: locationLabel || undefined,
        zip_code: selectedPlaceZip || searchZip.trim() || undefined,
        supporting_document_url: docUrl,
        onboarding: true,
      };

      const org = await Organization.createOrganization(payload);
      const orgId = org?.id;
      if (!orgId) {
        throw new Error('Organization created but no ID returned. Please try again.');
      }

      setOB(prev => ({
        ...prev,
        organization_id: orgId,
        organization_name: orgName.trim(),
        organization_place_id: selectedPlace?.place_id ?? null,
        organization_location: locationLabel || null,
        step_3_visited: true,
      }));

      try {
        await User.completeOnboarding(
          buildCoachCompletionPayload({
            organizationId: orgId,
            organizationName: orgName.trim(),
          })
        );
        await markOnboardingCompleteLocally();
        registerPushToken().catch(() => {});
      } catch (err) {
        if (__DEV__) console.warn('[step-3] Failed to complete onboarding:', err);
        await User.updatePreferences({
          organization_id: orgId,
          organization_name: orgName.trim(),
        }).catch(() => {});
      }

      const fallbackCompletedCoachUser = {
        ...(user || {}),
        onboarding_completed: true,
        organization_id: orgId,
        preferences: {
          ...(user?.preferences || {}),
          role: 'coach',
          onboarding_completed: true,
          organization_id: orgId,
        },
      };
      const { decision } = await getFreshPostAuthState(
        () => checkAuth(),
        undefined,
        fallbackCompletedCoachUser as any
      );
      captureBreadcrumb('Onboarding step 3 completed', 'onboarding.step3', {
        mode: 'create-org',
        next: decision.route,
      });
      if (decision.route === '/onboarding/coach-agreement') {
        router.replace({
          pathname: decision.route,
          params: { redirect: 'create-team' },
        } as any);
      } else if (decision.route === '/(tabs)') {
        router.replace({
          pathname: '/(tabs)/create-team',
          params: { organization_id: orgId },
        } as any);
      } else {
        router.replace(decision.route as any);
      }
    } catch (e: any) {
      captureBreadcrumb(
        'Onboarding step 3 submit failed',
        'onboarding.step3',
        {
          mode: showSearch ? 'search' : 'create',
          org_type: orgType || 'unknown',
        },
        'warning'
      );
      captureException(typeof e === 'string' ? new Error(e) : e, {
        tags: { context: 'onboarding-step-3' },
      });
      // Check if duplicate organization error
      if (
        e?.message?.includes('DUPLICATE_ORGANIZATION') ||
        e?.message?.toLowerCase().includes('duplicate')
      ) {
        Alert.alert(
          'Organization Already Exists',
          'This organization may already be on VarsityHub.\n\nPlease use the Search button above to find and join it instead.',
          [{ text: 'OK' }]
        );
      } else if (
        e?.message?.toLowerCase().includes('unauthorized') ||
        e?.status === 401 ||
        e?.status === 403
      ) {
        Alert.alert(
          'Authentication Required',
          'Please verify your email address or log in again to continue.',
          [
            { text: 'Verify Email', onPress: () => router.push('/verify') },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
      } else if (e?.data?.code === 'SPAM_DETECTED' || e?.message?.includes('SPAM_DETECTED')) {
        Alert.alert(
          'Invalid Name',
          'Please use a clear, descriptive name without special characters or excessive caps.'
        );
      } else if (
        e?.data?.code === 'PROFANITY_DETECTED' ||
        e?.message?.includes('PROFANITY_DETECTED')
      ) {
        Alert.alert(
          'Inappropriate Content',
          'The name or description contains inappropriate content. Please revise.'
        );
      } else if (
        e?.data?.code === 'BULLYING_DETECTED' ||
        e?.message?.includes('BULLYING_DETECTED')
      ) {
        Alert.alert(
          'Inappropriate Content',
          'The name or description contains harmful language. Please revise.'
        );
      } else {
        Alert.alert(
          'Create failed',
          toUserMessage(
            e,
            'Please check your entries and try again, or contact support@varsityhub.app.'
          )
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingLayout step={3} title={pageConfig.title} subtitle={pageConfig.subtitle}>
      <Stack.Screen options={{ headerShown: false }} />

      {alreadyExists ? (
        // Show success message if team/org already exists
        <>
          <View style={styles.successBox}>
            <MaterialIcons
              name="check-circle"
              size={48}
              color={colorScheme === 'dark' ? '#4ade80' : '#16A34A'}
              style={{ marginBottom: 16 }}
            />
            <Text style={styles.successTitle}>
              {pageConfig.type === 'team' ? 'Team Already Created' : 'Organization Already Created'}
            </Text>
            <Text style={styles.successText}>
              {pageConfig.type === 'team'
                ? `Your team "${existingTeam?.name || ob.team_name}" has already been set up. You can continue to the next step.`
                : `Organization "${existingOrg?.name || ob.organization_name}" has already been set up. You can continue to the next step.`}
            </Text>
          </View>

          <PrimaryButton
            label={checking ? 'Checking...' : 'Continue'}
            onPress={onContinue}
            disabled={!canContinue || checking}
            loading={saving || checking}
          />
        </>
      ) : checking ? (
        // Show loading state while checking
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
          <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
          <Text style={{ ...Type.body, color: Colors[colorScheme].mutedText }}>
            Checking for existing teams...
          </Text>
        </View>
      ) : (
        // Show creation form
        <>
          {isFinalCoachSetup ? (
            <View style={styles.finalSetupCard} accessibilityRole="summary">
              <View style={styles.finalSetupHeaderRow}>
                <MaterialIcons
                  name="verified"
                  size={22}
                  color={colorScheme === 'dark' ? '#93C5FD' : '#1D4ED8'}
                  style={{ marginRight: 10 }}
                />
                <Text style={styles.finalSetupTitle}>Approved Coach Setup</Text>
              </View>
              <Text style={styles.finalSetupBody}>
                Your coach application has already been approved. This step creates the live
                organization page for{' '}
                <Text style={styles.finalSetupBodyStrong}>
                  {submittedApplicationName || orgName.trim() || 'your organization'}
                </Text>
                .
              </Text>
              <Text style={styles.finalSetupBody}>
                You do not need to apply again or search for an existing league here.
              </Text>
            </View>
          ) : (
            <View style={styles.howItWorksCard} accessibilityRole="summary">
              <View style={styles.howItWorksHeaderRow}>
                <MaterialIcons
                  name="grid-view"
                  size={22}
                  color={colorScheme === 'dark' ? '#1D4ED8' : '#1D4ED8'}
                  style={{ marginRight: 10 }}
                />
                <Text style={styles.howItWorksTitle}>How It Works</Text>
              </View>
              <View style={styles.howItWorksTreeBox}>
                <Text style={styles.howItWorksTreeLine}>🏫 Stamford HS (Organization Page)</Text>
                <Text style={styles.howItWorksTreeLine}> └🏈 Varsity Football (Team Page)</Text>
                <Text style={styles.howItWorksTreeLine}> └🏀 JV Basketball (Team Page)</Text>
                <Text style={styles.howItWorksTreeLine}> └⚽ Girls Soccer (Team Page)</Text>
              </View>
              <Text style={styles.howItWorksDescLine}>
                <Text style={styles.howItWorksDescStrong}>Organization Page:</Text> Managed by
                administrator, displays all programs
              </Text>
              <Text style={styles.howItWorksDescLine}>
                <Text style={styles.howItWorksDescStrong}>Team Pages:</Text> Managed by Authorized
                Users you assign
              </Text>
            </View>
          )}

          {/* Organization creation/search form */}
          {canSearchForExistingOrganization && showSearch ? (
            <>
              {/* Search interface */}
              <View style={styles.searchBox}>
                <TouchableOpacity
                  style={styles.backButton}
                  onPress={() => {
                    setShowSearch(false);
                    setHasSearchedNearby(false);
                    clearOrganizations();
                    setSelectedOrg(null);
                    setShowOrgDropdown(false);
                  }}
                >
                  <MaterialIcons name="arrow-back" size={20} color={Colors[colorScheme].tint} />
                  <Text style={styles.backButtonText}>Create New Instead</Text>
                </TouchableOpacity>

                <Text style={styles.label}>Search by Name or Zip Code</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                  <Input
                    value={searchZip}
                    onChangeText={handleSearchInput}
                    placeholder="e.g., Westhill or 06902"
                    style={{ flex: 1, minHeight: 56, paddingVertical: 16, fontSize: 16 }}
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    inputAccessoryViewID=""
                  />
                  <TouchableOpacity
                    style={styles.searchActionButton}
                    onPress={() => executeNearbySearch()}
                    disabled={searching || !searchZip.trim()}
                  >
                    {searching ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <MaterialIcons name="search" size={20} color="#fff" />
                    )}
                  </TouchableOpacity>
                </View>

                <ZipCodeMapPreview
                  zipCode={searchZip}
                  title="Search Area"
                  subtitle="Searching for organizations near ZIP {zip}"
                  showCircle={false}
                />

                {nearbyOrgs.length > 0 && (
                  <>
                    <Text style={styles.label}>Select organization to join</Text>
                    <Pressable
                      style={[
                        styles.selectField,
                        {
                          borderColor: theme.border,
                          backgroundColor: isDark ? '#1F2937' : '#F9FAFB',
                          marginBottom: 8,
                        },
                      ]}
                      onPress={() => {
                        Keyboard.dismiss();
                        setShowOrgDropdown(v => !v);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Select organization to join"
                    >
                      <Text style={styles.selectFieldText}>
                        {selectedOrg
                          ? selectedOrg.name
                          : `${nearbyOrgs.length} organization${nearbyOrgs.length !== 1 ? 's' : ''} found — tap to select`}
                      </Text>
                      <MaterialIcons
                        name={showOrgDropdown ? 'expand-less' : 'expand-more'}
                        size={18}
                        color={isDark ? '#CBD5E1' : '#475569'}
                      />
                    </Pressable>
                    {showOrgDropdown && (
                      <ScrollView style={styles.orgList} showsVerticalScrollIndicator={false}>
                        {nearbyOrgs.map(org => (
                          <Pressable
                            key={org.id}
                            style={[
                              styles.orgCard,
                              selectedOrg?.id === org.id && {
                                borderWidth: 2,
                                borderColor: Colors[colorScheme].tint,
                              },
                            ]}
                            onPress={() => {
                              setSelectedOrg(org);
                              setShowOrgDropdown(false);
                            }}
                          >
                            <View style={styles.orgCardContent}>
                              <Text style={styles.orgCardName}>{org.name}</Text>
                              {org.location && (
                                <Text style={styles.orgCardLocation}>
                                  <MaterialIcons name="location-on" size={14} /> {org.location}
                                </Text>
                              )}
                              {(org.org_type || org.type) && (
                                <Text style={styles.orgCardSport}>
                                  {formatOrgType(org.org_type || org.type)}
                                </Text>
                              )}
                              <Text style={styles.orgCardMeta}>
                                {org._count?.teams ?? 0} team
                                {(org._count?.teams ?? 0) !== 1 ? 's' : ''} •{' '}
                                {org._count?.memberships ?? 0} member
                                {(org._count?.memberships ?? 0) !== 1 ? 's' : ''}
                              </Text>
                            </View>
                            <TouchableOpacity
                              style={styles.joinButton}
                              onPress={() => {
                                setSelectedOrg(org);
                                setShowOrgDropdown(false);
                                void requestToJoin(org);
                              }}
                            >
                              <Text style={styles.joinButtonText}>Request to Join</Text>
                            </TouchableOpacity>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                  </>
                )}

                {hasSearchedNearby && !searching && nearbyOrgs.length === 0 && (
                  <View
                    style={[
                      styles.searchEmptyState,
                      {
                        borderColor: theme.border,
                        backgroundColor: isDark ? '#111827' : '#F8FAFC',
                      },
                    ]}
                  >
                    <MaterialIcons
                      name="travel-explore"
                      size={22}
                      color={isDark ? '#93C5FD' : '#2563EB'}
                    />
                    <Text style={styles.searchEmptyTitle}>
                      No organizations found for that search
                    </Text>
                    <Text style={styles.searchEmptyText}>
                      This clean test slate does not have any active leagues yet. Tap Create New
                      Instead to set up the first organization.
                    </Text>
                  </View>
                )}
              </View>
            </>
          ) : (
            <>
              {canSearchForExistingOrganization ? (
                <>
                  <View style={styles.modeToggleWrapper}>
                    <View style={styles.modeToggleBracket}>
                      <Pressable
                        style={[
                          styles.modeToggleOption,
                          showSearch && styles.modeToggleOptionActive,
                        ]}
                        onPress={() => {
                          setShowSearch(true);
                          setOB(prev => ({
                            ...prev,
                            join_request_pending: false,
                            organization_id: undefined,
                            organization_name: undefined,
                            step_3_visited: false,
                          }));
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Search for existing organization"
                      >
                        <MaterialIcons
                          name="search"
                          size={16}
                          color={showSearch ? '#fff' : isDark ? '#E2E8F0' : '#0F172A'}
                        />
                        <Text
                          style={[styles.modeToggleText, showSearch && styles.modeToggleTextActive]}
                        >
                          Search
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[
                          styles.modeToggleOption,
                          !showSearch && styles.modeToggleOptionActive,
                        ]}
                        onPress={() => {
                          setShowSearch(false);
                          clearOrganizations();
                          setOB(prev => ({
                            ...prev,
                            join_request_pending: false,
                            organization_id: undefined,
                            organization_name: undefined,
                            step_3_visited: false,
                          }));
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Create a new organization"
                      >
                        <MaterialIcons
                          name="add"
                          size={16}
                          color={!showSearch ? '#fff' : isDark ? '#E2E8F0' : '#0F172A'}
                        />
                        <Text
                          style={[
                            styles.modeToggleText,
                            !showSearch && styles.modeToggleTextActive,
                          ]}
                        >
                          Create New
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  <Text
                    style={{
                      fontSize: 13,
                      color: isDark ? '#94A3B8' : '#64748B',
                      textAlign: 'center',
                      marginBottom: 12,
                    }}
                  >
                    {showSearch
                      ? 'My league already exists on VarsityHub \u2014 I want to request to join it'
                      : "I'm starting a new league \u2014 I'll be the owner and admin"}
                  </Text>
                </>
              ) : null}

              <Text style={styles.label}>Organization Name</Text>
              <Input
                value={orgName}
                onChangeText={handleOrgNameChange}
                placeholder="Westhill High School"
                style={{ marginBottom: 12, minHeight: 64, paddingVertical: 18, fontSize: 16 }}
                autoCorrect={false}
              />

              <Text style={styles.label}>Organization Type</Text>
              <Pressable
                style={[
                  styles.selectField,
                  {
                    borderColor: theme.border,
                    backgroundColor: isDark ? '#1F2937' : '#F9FAFB',
                  },
                ]}
                onPress={() => {
                  Keyboard.dismiss();
                  setShowTypePicker(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Select organization type"
              >
                <Text style={styles.selectFieldText}>
                  {orgType ? formatOrgType(orgType) : 'Select organization type'}
                </Text>
                <MaterialIcons
                  name="expand-more"
                  size={18}
                  color={isDark ? '#CBD5E1' : '#475569'}
                />
              </Pressable>

              <Text style={[styles.label, { marginTop: 16 }]}>Supporting Documents (Required)</Text>
              <Text
                style={[Type.caption, { color: isDark ? '#9CA3AF' : '#6B7280', marginBottom: 8 }]}
              >
                Upload a file or image to verify your organization (e.g., school letterhead,
                registration document)
              </Text>
              <Pressable
                style={[
                  styles.selectField,
                  {
                    borderColor: theme.border,
                    backgroundColor: isDark ? '#1F2937' : '#F9FAFB',
                    minHeight: 80,
                    paddingVertical: 12,
                  },
                ]}
                onPress={() => {
                  Alert.alert('Upload Document', 'Choose a source for your supporting document', [
                    {
                      text: 'Photo Library',
                      onPress: async () => {
                        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
                        if (status !== 'granted') {
                          Alert.alert(
                            'Permission Needed',
                            'Please allow access to your photos to upload a supporting document.'
                          );
                          return;
                        }
                        const result = await ImagePicker.launchImageLibraryAsync({
                          ...pickerMediaTypesProp(),
                          allowsEditing: false,
                          quality: 0.9,
                        });
                        if (!result.canceled && result.assets?.[0]?.uri) {
                          const materialized = await materializeICloudAssetIfNeeded(
                            result.assets[0].uri
                          );
                          setSupportingDocumentUri(materialized);
                          setSupportingDocumentUrl(null);
                          setSupportingDocumentName(null);
                          setSupportingDocumentMimeType(result.assets[0].mimeType || 'image/jpeg');
                        }
                      },
                    },
                    {
                      text: 'Choose File',
                      onPress: async () => {
                        const result = await DocumentPicker.getDocumentAsync({
                          type: ['application/pdf', 'image/*'],
                          copyToCacheDirectory: true,
                        });
                        if (!result.canceled && result.assets?.[0]?.uri) {
                          setSupportingDocumentUri(result.assets[0].uri);
                          setSupportingDocumentUrl(null);
                          setSupportingDocumentName(result.assets[0].name || 'Document');
                          setSupportingDocumentMimeType(result.assets[0].mimeType || null);
                        }
                      },
                    },
                    { text: 'Cancel', style: 'cancel' },
                  ]);
                }}
                accessibilityRole="button"
                accessibilityLabel="Upload supporting document"
              >
                {supportingDocumentUri ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {supportingDocumentName &&
                    supportingDocumentName.toLowerCase().endsWith('.pdf') ? (
                      <View
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 8,
                          backgroundColor: isDark ? '#374151' : '#E5E7EB',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <MaterialIcons
                          name="picture-as-pdf"
                          size={28}
                          color={isDark ? '#F87171' : '#DC2626'}
                        />
                      </View>
                    ) : (
                      <Image
                        source={{ uri: supportingDocumentUri }}
                        style={{ width: 48, height: 48, borderRadius: 8 }}
                      />
                    )}
                    <Text style={[styles.selectFieldText, { flex: 1 }]}>
                      {supportingDocumentName || 'Document selected'}
                    </Text>
                    <Pressable
                      onPress={() => {
                        setSupportingDocumentUri(null);
                        setSupportingDocumentUrl(null);
                        setSupportingDocumentName(null);
                        setSupportingDocumentMimeType(null);
                      }}
                      hitSlop={8}
                    >
                      <MaterialIcons
                        name="close"
                        size={20}
                        color={isDark ? '#9CA3AF' : '#6B7280'}
                      />
                    </Pressable>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <MaterialIcons
                      name="upload-file"
                      size={24}
                      color={isDark ? '#60A5FA' : '#2563EB'}
                    />
                    <Text style={styles.selectFieldText}>Tap to upload file or image</Text>
                  </View>
                )}
              </Pressable>
              <View style={{ height: 12 }} />
            </>
          )}

          {(!canSearchForExistingOrganization || !showSearch) && (
            <>
              <Text style={styles.label}>Zip Code</Text>
              <Input
                value={searchZip}
                onChangeText={(text: string) => setSearchZip(text.replace(/\D/g, '').slice(0, 5))}
                placeholder={
                  selectedPlace
                    ? 'ZIP auto-filled from selected address'
                    : 'Enter zip code (e.g., 06902)'
                }
                keyboardType="numeric"
                maxLength={5}
                editable={!selectedPlace}
                style={{
                  minHeight: 56,
                  paddingVertical: 16,
                  fontSize: 16,
                  marginBottom: 8,
                  opacity: selectedPlace ? 0.7 : 1,
                }}
              />
              <Text
                style={[Type.caption, { color: isDark ? '#9CA3AF' : '#6B7280', marginBottom: 16 }]}
              >
                {selectedPlace
                  ? 'ZIP is linked to the selected address. Clear or change the address to edit ZIP manually.'
                  : 'Add an address below to auto-fill ZIP and improve nearby organization search results.'}
              </Text>

              <Text style={styles.label}>Location</Text>
              <View style={{ zIndex: 10, overflow: 'visible' }}>
                <LocationPicker
                  value={location}
                  onLocationSelect={handleLocationSelect}
                  placeholder="Start typing an address, school, or city"
                  zipBias={searchZip.replace(/\D/g, '').length === 5 ? searchZip : undefined}
                />
              </View>
              {duplicateOrg && (
                <View style={styles.duplicateWarningBox}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                    <MaterialIcons
                      name="warning"
                      size={16}
                      color="#F59E0B"
                      style={{ marginRight: 8 }}
                    />
                    <Text style={[styles.duplicateWarningText, { flex: 1 }]}>
                      An organization with a similar name already exists:{' '}
                      <Text style={{ fontWeight: '700' }}>{duplicateOrg.name}</Text>
                      {duplicateOrg.location ? ` (${duplicateOrg.location})` : ''}
                    </Text>
                  </View>
                  <View
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}
                  >
                    <TouchableOpacity
                      style={styles.duplicateJoinButton}
                      onPress={() => void requestToJoin(duplicateOrg)}
                      accessibilityRole="button"
                      accessibilityLabel={`Join ${duplicateOrg.name}`}
                    >
                      <MaterialIcons
                        name="login"
                        size={16}
                        color="#fff"
                        style={{ marginRight: 4 }}
                      />
                      <Text style={styles.duplicateJoinButtonText}>Join {duplicateOrg.name}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setDuplicateOrg(null)}
                      accessibilityRole="button"
                      accessibilityLabel="Create new organization anyway"
                    >
                      <Text style={styles.duplicateCreateAnywayText}>Create new anyway</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {selectedPlaceZip ? (
                <ZipCodeMapPreview
                  zipCode={selectedPlaceZip}
                  title="Organization Location"
                  subtitle="Your organization is located near ZIP {zip}"
                  showCircle={false}
                />
              ) : null}
            </>
          )}

          {/* Join Request Modal */}
          {requestingJoin && selectedOrg && (
            <View style={styles.enhancedModalOverlay} accessibilityViewIsModal>
              <View style={styles.enhancedModalCard}>
                <View style={styles.enhancedModalHeader}>
                  <View style={styles.enhancedModalIconCircle}>
                    <MaterialIcons name="school" size={22} color="#fff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.enhancedModalTitle}>Request to Join</Text>
                    <Text style={styles.enhancedModalOrg}>{selectedOrg.name}</Text>
                  </View>
                  <TouchableOpacity
                    accessibilityLabel="Close join request"
                    onPress={() => {
                      setRequestingJoin(false);
                      setSelectedOrg(null);
                      setJoinMessage('');
                    }}
                    style={styles.closeTouch}
                  >
                    <MaterialIcons name="close" size={20} color={Colors[colorScheme].mutedText} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.enhancedModalLabel}>Message (Optional)</Text>
                <View style={styles.textAreaWrapper}>
                  <TextInput
                    value={joinMessage}
                    onChangeText={setJoinMessage}
                    placeholder="Introduce yourself to the administrator..."
                    multiline
                    style={styles.textArea}
                    maxLength={300}
                    accessibilityLabel="Optional message to organization owner"
                  />
                  <View style={styles.charCountRow}>
                    <Text style={styles.charCountText}>{joinMessage.length}/300</Text>
                    {joinMessage.length > 280 && (
                      <Text style={styles.charLimitWarning}>
                        Consider keeping it concise (under 280 characters).
                      </Text>
                    )}
                  </View>
                </View>

                <View style={styles.enhancedActionsRow}>
                  <TouchableOpacity
                    style={styles.secondaryAction}
                    onPress={() => {
                      setRequestingJoin(false);
                      setSelectedOrg(null);
                      setJoinMessage('');
                    }}
                    accessibilityRole="button"
                  >
                    <MaterialIcons name="arrow-back" size={16} color={Colors[colorScheme].tint} />
                    <Text style={styles.secondaryActionText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.primaryAction,
                      (saving || joinMessage.length > 300) && { opacity: 0.5 },
                    ]}
                    onPress={submitJoinRequest}
                    disabled={saving || joinMessage.length > 300}
                    accessibilityRole="button"
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons
                          name="send"
                          size={16}
                          color="#fff"
                          style={{ marginRight: 6 }}
                        />
                        <Text style={styles.primaryActionText}>Send Request</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                <View style={styles.helperInfo}>
                  <MaterialIcons
                    name="info-outline"
                    size={16}
                    color={Colors[colorScheme].mutedText}
                  />
                  <Text style={styles.helperInfoText}>
                    The administrator will review your request. You’ll get an email when it’s
                    approved.
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Compact Accessible Organization Type Modal */}
          {showTypePicker && (
            <View style={styles.typeModalOverlay} accessibilityViewIsModal>
              <View style={styles.typeModalCard}>
                <Text style={styles.typeModalTitle}>Organization Type</Text>
                {['school', 'club', 'league', 'university', 'college', 'professional'].map(t => (
                  <Pressable
                    key={t}
                    onPress={() => {
                      Keyboard.dismiss();
                      setOrgType(t as any);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: orgType === t }}
                    style={[styles.typeOption, orgType === t && styles.typeOptionActive]}
                  >
                    <MaterialIcons
                      name={orgType === t ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={
                        orgType === t
                          ? isDark
                            ? '#3B82F6'
                            : '#1D4ED8'
                          : isDark
                            ? '#94A3B8'
                            : '#64748B'
                      }
                    />
                    <Text style={styles.typeOptionText}>{formatOrgType(t)}</Text>
                  </Pressable>
                ))}
                <View style={styles.typeModalActions}>
                  <Pressable
                    onPress={() => {
                      setShowTypePicker(false);
                      setOrgType(null);
                    }}
                    style={styles.typeCancel}
                    accessibilityRole="button"
                  >
                    <Text style={styles.typeCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowTypePicker(false)}
                    disabled={!orgType}
                    style={[styles.typeConfirm, !orgType && { opacity: 0.4 }]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.typeConfirmText}>Done</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {(!canSearchForExistingOrganization || !showSearch) && (
            <PrimaryButton
              label={saving ? 'Creating...' : 'Continue'}
              onPress={onContinue}
              disabled={!canContinue}
              loading={saving}
            />
          )}
        </>
      )}
    </OnboardingLayout>
  );
}

export default Step3League;
