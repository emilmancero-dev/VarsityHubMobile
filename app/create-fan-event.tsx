import { toUserMessage } from '@/utils/toUserMessage';
import { styles } from '@/styles/create-fan-event.styles';
import KeyboardAwareScreen from '@/components/KeyboardAwareScreen';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useLocationAutocomplete } from '@/hooks/useLocationAutocomplete';
import { APP_ROUTES } from '@/utils/appRoutes';
import { getAuthSnapshot } from '@/utils/authState';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Event, Game, Team as TeamAPI } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import { uploadFile } from '@/api/upload';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import { handleCoachAccessError } from '@/utils/coachAccess';
import { uploadEventBannerFromUri as uploadEventBannerAsset } from '@/utils/eventBannerUpload';
import { sanitizeText } from '@/utils/formUtils';
import { buildOpponentLink } from '@/utils/gameOpponent';
import { pickerMediaTypesProp } from '@/utils/picker';
import { getCoachAccessState } from '@/utils/roleChecks';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { AppearancePreset } from './components/AppearancePicker';
import MatchBanner from './components/MatchBanner';

const EVENT_TYPES = [
  { value: 'game', label: 'Game/Match', emoji: '🏈' },
  { value: 'watch_party', label: 'Watch Party', emoji: '📺' },
  { value: 'fundraiser', label: 'Fundraiser', emoji: '💰' },
  { value: 'team_meeting', label: 'Pep Rally', emoji: '📣' },
  { value: 'bbq', label: 'BBQ/Social', emoji: '🍔' },
  { value: 'team_meal', label: 'Team Meal', emoji: '🍽️' },
  { value: 'other', label: 'Other', emoji: '📌' },
];

type MeResponse = {
  approval_status?: string | null;
  preferences?: {
    role?: string | null;
    onboarding_completed?: boolean;
  } | null;
};

type MyEventSummary = {
  approval_status?: string | null;
};

type FollowedTeam = {
  id: string;
  name?: string | null;
  logo_url?: string | null;
  avatar_url?: string | null;
  venue_address?: string | null;
};

type TeamOption = {
  id: string;
  name: string;
  logo?: string;
  venue_address: string | null;
};

type TeamSearchResponse = {
  items?: Array<{
    id: string;
    name?: string | null;
  }>;
};

type CreateEventError = {
  code?: string;
  message?: string;
  data?: {
    code?: string;
    message?: string;
  };
};

type GameCreatePayload = {
  title: string;
  date: string;
  location: string;
  venue_address: string;
  venue_place_id?: string;
  description?: string;
  event_type: 'game';
  banner_url: string;
  cover_image_url: string;
  appearance: AppearancePreset;
  home_team: string;
  away_team: string;
  home_team_id?: string;
  away_team_id?: string;
};

type EventCreatePayload = {
  title: string;
  description: string;
  event_type: string;
  location: string;
  venue_address: string;
  venue_place_id?: string;
  date: string;
  banner_url: string;
  cover_image_url: string;
  appearance: AppearancePreset;
  home_team_id?: string;
};

function CreateFanEventScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const { user, checkAuth } = useAuth();

  // Detect user role to differentiate Pitch Event (fan) vs Create Event (coach)
  const [userRole, setUserRole] = useState<string>('fan');
  const [roleError, setRoleError] = useState(false);
  const [pendingEventCount, setPendingEventCount] = useState<number | null>(null);
  const locationInputRef = useRef<TextInput>(null);
  const eventLimitReached =
    userRole !== 'coach' && pendingEventCount !== null && pendingEventCount >= 3;

  useEffect(() => {
    getAuthSnapshot(checkAuth, user)
      .then((u: MeResponse) => {
        const coachAccess = getCoachAccessState(u);
        const canCreateCoachEvents =
          coachAccess.canAccessCoachTools && coachAccess.onboardingCompleted;
        setUserRole(canCreateCoachEvents ? 'coach' : 'fan');
        // Fans can't create game events — default to watch_party
        if (!canCreateCoachEvents) {
          setEventType('watch_party');
        }
      })
      .catch(() => {
        setEventType('watch_party');
        setRoleError(true);
      });
    // Pre-check pending event count so we can warn before form fill
    Event.mine()
      .then((events: MyEventSummary[]) => {
        if (Array.isArray(events)) {
          const pending = events.filter(event => event.approval_status === 'pending').length;
          setPendingEventCount(pending);
        }
      })
      .catch(() => {
        // If count check fails, allow creation — server enforces the real limit
        setPendingEventCount(0);
      });
  }, [checkAuth, user]);
  const isCoach = userRole === 'coach';

  // Load followed teams
  const [rawTeams, setRawTeams] = useState<FollowedTeam[]>([]);
  const [_teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState(false);

  useEffect(() => {
    const loadFollowedTeams = async () => {
      try {
        setTeamsLoading(true);
        setTeamsError(false);
        const teams = await TeamAPI.followed();
        setRawTeams(Array.isArray(teams) ? (teams as FollowedTeam[]) : []);
      } catch (error: unknown) {
        if (__DEV__) console.warn('[CreateFanEvent] Failed to load followed teams:', error);
        setRawTeams([]);
        setTeamsError(true);
      } finally {
        setTeamsLoading(false);
      }
    };
    void loadFollowedTeams();
  }, []);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState<string>('game');
  const [date, setDate] = useState(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const {
    location,
    setLocation,
    locationSuggestions,
    locationQuerying,
    locationTouched,
    setLocationTouched,
    selectedPlace,
    setSelectedPlace,
    handleLocationChange,
    handleSelectLocation,
  } = useLocationAutocomplete({ onClearLocationError: setErrors });
  const bannerCaptureRef = useRef<ViewShot | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  // Banner appearance is fixed to the default; the in-form style picker was
  // removed (device-testing feedback) — users just upload a custom photo.
  const [appearance] = useState<AppearancePreset>('classic');
  const [uploadingBanner, setUploadingBanner] = useState(false);

  // Team selection for fan event pitches (must be tied to a team)
  const [pitchTeamId, setPitchTeamId] = useState('');
  const [pitchTeamName, setPitchTeamName] = useState('');
  const [showPitchTeamPicker, setShowPitchTeamPicker] = useState(false);
  const [pitchTeamQuery, setPitchTeamQuery] = useState('');

  // Game-specific fields (coach only)
  const [selectedTeam, setSelectedTeam] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [opponent, setOpponent] = useState('');
  // Set only when the user picks a suggestion — links the real Team row.
  // Cleared on free-text edits (free text = display-only placeholder).
  const [opponentTeamId, setOpponentTeamId] = useState('');
  const [opponentSuggestions, setOpponentSuggestions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [opponentSearching, setOpponentSearching] = useState(false);
  const opponentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gameType, setGameType] = useState<'home' | 'away'>('home');
  const [showTeamPicker, setShowTeamPicker] = useState(false);

  const teams = useMemo<TeamOption[]>(() => {
    if (!Array.isArray(rawTeams) || rawTeams.length === 0) return [];
    return rawTeams.map(team => ({
      id: String(team.id),
      name: team.name || 'Unknown Team',
      logo: (team.logo_url || team.avatar_url || undefined) as string | undefined,
      venue_address: (team.venue_address || null) as string | null,
    }));
  }, [rawTeams]);

  // Client-side search over the user's followed teams for the pitch picker
  const filteredPitchTeams = useMemo(() => {
    const q = pitchTeamQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(t => t.name.toLowerCase().includes(q));
  }, [teams, pitchTeamQuery]);

  const eventTypeLabel = useMemo(
    () => EVENT_TYPES.find(type => type.value === eventType)?.label || 'Event',
    [eventType]
  );

  const selectedTeamLogo = useMemo(
    () => teams.find(team => team.id === selectedTeamId || team.name === selectedTeam)?.logo,
    [selectedTeam, selectedTeamId, teams]
  );

  const pitchTeamLogo = useMemo(
    () => teams.find(team => team.id === pitchTeamId)?.logo,
    [pitchTeamId, teams]
  );

  const previewBanner = useMemo(() => {
    if (isCoach && eventType === 'game') {
      return {
        leftName: (gameType === 'home' ? selectedTeam : opponent).trim() || 'Home Team',
        rightName: (gameType === 'home' ? opponent : selectedTeam).trim() || 'Away Team',
        leftImage: gameType === 'home' ? selectedTeamLogo || null : null,
        rightImage: gameType === 'away' ? selectedTeamLogo || null : null,
      };
    }

    return {
      leftName: title.trim() || 'Event',
      rightName: (!isCoach ? pitchTeamName : eventTypeLabel).trim() || eventTypeLabel,
      leftImage: !isCoach ? pitchTeamLogo || null : null,
      rightImage: null,
    };
  }, [
    eventType,
    eventTypeLabel,
    gameType,
    isCoach,
    opponent,
    pitchTeamLogo,
    pitchTeamName,
    selectedTeam,
    selectedTeamLogo,
    title,
  ]);

  // Pre-fill venue when Home Game is selected and a team with a saved venue is chosen
  useEffect(() => {
    if (!selectedTeamId || eventType !== 'game') return;
    const team = teams.find(t => t.id === selectedTeamId);
    if (gameType === 'home' && team?.venue_address) {
      if (!locationTouched) {
        setLocation(team.venue_address);
        setSelectedPlace(null);
      }
    } else if (gameType === 'away') {
      if (!locationTouched) {
        setLocation('');
        setSelectedPlace(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes locationTouched to avoid resetting location on every touch state change
  }, [gameType, selectedTeamId, teams, eventType]);

  // Opponent team search
  const handleOpponentChange = useCallback((text: string) => {
    setOpponent(text);
    setOpponentTeamId(''); // typing = free-text placeholder, drop the link
    setErrors(prev => ({ ...prev, opponent: '' }));
    if (opponentTimerRef.current) clearTimeout(opponentTimerRef.current);
    if (text.trim().length < 2) {
      setOpponentSuggestions([]);
      setOpponentSearching(false);
      return;
    }
    setOpponentSearching(true);
    opponentTimerRef.current = setTimeout(async () => {
      try {
        const results = await TeamAPI.list(text.trim(), false, { limit: 6 });
        const list = Array.isArray(results)
          ? (results as TeamSearchResponse['items'])
          : Array.isArray((results as TeamSearchResponse | null)?.items)
            ? (results as TeamSearchResponse).items
            : [];
        setOpponentSuggestions(
          (list || []).map(team => ({ id: String(team.id), name: String(team.name || '') }))
        );
      } catch {
        setOpponentSuggestions([]);
      } finally {
        setOpponentSearching(false);
      }
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (opponentTimerRef.current) clearTimeout(opponentTimerRef.current);
    };
  }, []);

  const uploadBannerFromUri = useCallback(async (uri: string) => {
    setUploadingBanner(true);
    try {
      const nextUrl = await uploadEventBannerAsset(uri);
      setBannerUrl(nextUrl);
    } finally {
      setUploadingBanner(false);
    }
  }, []);

  const pickBannerFromLibrary = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission required',
        'Photo library permission is needed to upload an event photo.',
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
      // Event cards render banners at 4:5 (app/feed.tsx FullBleedCardImage) —
      // crop at the displayed ratio so uploads aren't re-cropped at render time.
      aspect: [4, 5],
      quality: 0.9,
      exif: false,
    });

    if (!result.canceled && result.assets[0]) {
      try {
        await uploadBannerFromUri(result.assets[0].uri);
      } catch (error: unknown) {
        const uploadError = error as CreateEventError;
        Alert.alert(
          'Upload Failed',
          toUserMessage(uploadError, 'Failed to upload event photo. Please try again.')
        );
      }
    }
  }, [uploadBannerFromUri]);

  const takeBannerPhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Camera permission is needed to take an event photo.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      ...pickerMediaTypesProp(),
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.9,
      exif: false,
    });

    if (!result.canceled && result.assets[0]) {
      try {
        await uploadBannerFromUri(result.assets[0].uri);
      } catch (error: unknown) {
        const uploadError = error as CreateEventError;
        Alert.alert(
          'Upload Failed',
          toUserMessage(uploadError, 'Failed to upload event photo. Please try again.')
        );
      }
    }
  }, [uploadBannerFromUri]);

  const showBannerOptions = useCallback(() => {
    Alert.alert('Event Photo', 'Choose how you want to add a custom event photo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Photo Library', onPress: () => void pickBannerFromLibrary() },
      { text: 'Take Photo', onPress: () => void takeBannerPhoto() },
    ]);
  }, [pickBannerFromLibrary, takeBannerPhoto]);

  const captureGeneratedBanner = useCallback(async () => {
    if (!bannerCaptureRef.current) return null;
    setUploadingBanner(true);
    try {
      const uri = await captureRef(bannerCaptureRef, { format: 'png', quality: 0.9 });
      const uploadResult = await uploadFile(
        getApiBaseUrl(),
        uri,
        'generated-event-banner.png',
        'image/png'
      );
      return uploadResult?.url || uploadResult?.path || null;
    } finally {
      setUploadingBanner(false);
    }
  }, []);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (isCoach && eventType === 'game') {
      if (!selectedTeam.trim()) {
        newErrors.selectedTeam = 'Team is required';
      }
      if (!opponent.trim()) {
        newErrors.opponent = 'Opponent is required';
      }
    } else {
      if (!title.trim()) {
        newErrors.title = 'Event title is required';
      }
      if (!pitchTeamId) {
        newErrors.pitchTeam = 'Please select a team for this event';
      }
    }

    if (!location.trim()) {
      newErrors.location = 'Location is required';
    }

    if (date < new Date()) {
      newErrors.date = 'Event date cannot be in the past';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    setSubmitting(true);

    try {
      const gameDateTime = new Date(date);
      let finalBannerUrl = bannerUrl;
      if (!finalBannerUrl) {
        finalBannerUrl = await captureGeneratedBanner();
        if (!finalBannerUrl) {
          throw new Error('Failed to prepare an event banner. Please try again.');
        }
      }

      if (isCoach && eventType === 'game') {
        // Coach creating a game event — include team IDs
        const sanitizedOpponent = sanitizeText(opponent);
        const homeTeamName = gameType === 'home' ? selectedTeam : sanitizedOpponent;
        const awayTeamName = gameType === 'home' ? sanitizedOpponent : selectedTeam;

        const gamePayload: GameCreatePayload = {
          title: `${homeTeamName} vs ${awayTeamName}`,
          date: gameDateTime.toISOString(),
          location: selectedPlace?.description || location,
          venue_address: selectedPlace?.description || location,
          venue_place_id: selectedPlace?.place_id,
          description: sanitizeText(description) || undefined,
          event_type: 'game',
          banner_url: finalBannerUrl,
          cover_image_url: finalBannerUrl,
          appearance,
          home_team: homeTeamName,
          away_team: awayTeamName,
        };

        if (gameType === 'home' && selectedTeamId) {
          gamePayload.home_team_id = selectedTeamId;
        } else if (gameType === 'away' && selectedTeamId) {
          gamePayload.away_team_id = selectedTeamId;
        }
        // Link the opponent's Team row when one was picked from suggestions
        // (manage-season's handleSaveGame already does this; this surface was
        // missed in the July 4th round — see 2026-07-05 plan doc).
        Object.assign(gamePayload, buildOpponentLink(gameType, opponentTeamId));

        await Game.create(gamePayload);
      } else {
        // Non-game event or fan pitch — must be tied to a team
        const eventData: EventCreatePayload = {
          title: sanitizeText(title),
          description: sanitizeText(description),
          event_type: eventType,
          location: selectedPlace?.description || location,
          venue_address: selectedPlace?.description || location,
          venue_place_id: selectedPlace?.place_id,
          date: gameDateTime.toISOString(),
          banner_url: finalBannerUrl,
          cover_image_url: finalBannerUrl,
          appearance,
        };

        // Tie event to the selected team
        if (pitchTeamId) {
          eventData.home_team_id = pitchTeamId;
        }

        await Event.create(eventData as never);
      }

      if (!isCoach) {
        analytics.track(ANALYTICS_EVENTS.COACH_APPROVAL_REQUESTED, {
          event_type: eventType,
          team_id: pitchTeamId || undefined,
        });
      }

      Alert.alert(
        isCoach ? 'Event Created!' : 'Event Pitched!',
        isCoach
          ? 'Your event has been submitted for review.'
          : "Your event idea has been submitted! A coach or admin will review it and you'll be notified.",
        [{ text: 'OK', onPress: () => safeGoBack(router) }]
      );
    } catch (error: unknown) {
      const e = error as CreateEventError;
      const errorCode = e?.code || e?.data?.code;
      const errorMessage = e?.message || e?.data?.message;

      if (handleCoachAccessError(router, e, 'creating events', user as any)) {
        return;
      } else if (errorCode === 'EVENT_LIMIT_EXCEEDED') {
        Alert.alert(
          'Event Limit Reached',
          "You've reached your limit of 3 pending events. Wait for one to be approved or rejected before submitting another.",
          [{ text: 'OK' }]
        );
      } else {
        const detailedError = toUserMessage(e, 'Failed to create event. Please try again.');
        if (__DEV__)
          console.error('[CreateFanEvent] Create event error:', {
            error: e,
            errorMessage,
            errorCode,
            eventType,
          });
        Alert.alert('Error', detailedError);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      setDate(selectedDate);
      if (Platform.OS === 'ios') {
        setShowDatePicker(false);
      }
    }
  };

  const handleTimeChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowTimePicker(false);
    }
    if (selectedDate) {
      const newDate = new Date(date);
      newDate.setHours(selectedDate.getHours());
      newDate.setMinutes(selectedDate.getMinutes());
      setDate(newDate);
      if (Platform.OS === 'ios') {
        setShowTimePicker(false);
      }
    }
  };

  const isGameEvent = isCoach && eventType === 'game';

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen
        options={{
          title: isCoach ? 'Create Event' : 'Pitch Event',
          headerShown: true,
          headerBackTitle: 'Back',
          headerBackVisible: true,
        }}
      />

      <KeyboardAwareScreen style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
            {isCoach ? 'Create Event' : 'Pitch an Event'}
          </Text>
          <Text style={[styles.subtitle, { color: Colors[colorScheme].mutedText }]}>
            {isCoach
              ? 'Create a game, watch party, fundraiser, or other team event'
              : 'Suggest a community event — watch parties, fundraisers, socials, and more. A coach or admin will review your idea.'}
          </Text>
        </View>

        {/* Role load error */}
        {roleError && (
          <View
            style={[
              styles.infoBox,
              { backgroundColor: '#FEF2F2', borderColor: '#FCA5A5', marginBottom: 16 },
            ]}
          >
            <MaterialIcons name="warning" size={20} color="#DC2626" />
            <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: '#991B1B' }}>
              Couldn't verify your account type. Showing fan options. Pull down to refresh.
            </Text>
          </View>
        )}

        {/* Event Limit Warning */}
        {eventLimitReached && (
          <View
            style={[
              styles.infoBox,
              { backgroundColor: '#FEF3C7', borderColor: '#F59E0B', marginBottom: 16 },
            ]}
          >
            <MaterialIcons name="warning" size={20} color="#B45309" />
            <Text
              style={{
                flex: 1,
                fontSize: 13,
                lineHeight: 18,
                color: colorScheme === 'dark' ? '#FDE68A' : '#92400E',
              }}
            >
              You have {pendingEventCount} pending events (limit: 3). Wait for approval or{' '}
              <Text
                style={{ fontWeight: '700' }}
                onPress={() => router.push(APP_ROUTES.manageSubscription as never)}
              >
                upgrade your plan
              </Text>{' '}
              to create more.
            </Text>
          </View>
        )}

        {/* Event Type */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Event Type *</Text>
          <View style={styles.typeGrid}>
            {EVENT_TYPES.map(type => {
              // Fans cannot create game events — only coaches can
              if (!isCoach && type.value === 'game') return null;
              return (
                <Pressable
                  key={type.value}
                  style={[
                    styles.typeButton,
                    {
                      backgroundColor: Colors[colorScheme].card,
                      borderColor:
                        eventType === type.value
                          ? Colors[colorScheme].tint
                          : Colors[colorScheme].border,
                    },
                    eventType === type.value && styles.typeButtonActive,
                  ]}
                  onPress={() => {
                    setEventType(type.value);
                    if (type.value !== 'game') {
                      setOpponent('');
                    }
                  }}
                >
                  <Text style={styles.typeEmoji}>{type.emoji}</Text>
                  <Text
                    style={[
                      styles.typeLabel,
                      {
                        color:
                          eventType === type.value
                            ? Colors[colorScheme].tint
                            : Colors[colorScheme].text,
                      },
                    ]}
                  >
                    {type.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Title — always required for fans, required for non-game coach events */}
        {(!isCoach || !isGameEvent) && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
              {isCoach ? 'Event Title *' : 'Event Name *'}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.title ? '#DC2626' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              placeholder={
                isCoach ? 'e.g., Varsity Football Watch Party' : 'e.g., Homecoming Tailgate Party'
              }
              placeholderTextColor={Colors[colorScheme].mutedText}
              value={title}
              onChangeText={setTitle}
              returnKeyType="next"
              onSubmitEditing={() => locationInputRef.current?.focus()}
            />
            {errors.title && <Text style={styles.errorText}>{errors.title}</Text>}
          </View>
        )}

        {/* Team selection for fan event pitches (non-game events must be tied to a team) */}
        {!isGameEvent && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Team *</Text>
            <Pressable
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.pitchTeam ? '#DC2626' : Colors[colorScheme].border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                },
              ]}
              onPress={() => setShowPitchTeamPicker(true)}
            >
              <Text
                style={[
                  {
                    color: pitchTeamName ? Colors[colorScheme].text : Colors[colorScheme].mutedText,
                  },
                ]}
              >
                {pitchTeamName || 'Select a team'}
              </Text>
              <MaterialIcons name="expand-more" size={20} color={Colors[colorScheme].mutedText} />
            </Pressable>
            {errors.pitchTeam && <Text style={styles.errorText}>{errors.pitchTeam}</Text>}
            {!_teamsLoading && teamsError && (
              <View
                style={[
                  styles.infoBox,
                  {
                    backgroundColor: '#FEF2F2',
                    borderColor: '#FECACA',
                    marginTop: 8,
                    marginBottom: 0,
                  },
                ]}
              >
                <MaterialIcons name="error-outline" size={20} color="#DC2626" />
                <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: '#991B1B' }}>
                  Couldn't load your teams. Pull to refresh.
                </Text>
              </View>
            )}
            {!_teamsLoading && !teamsError && teams.length === 0 && (
              <View
                style={[
                  styles.infoBox,
                  {
                    backgroundColor: '#FEF3C7',
                    borderColor: '#F59E0B',
                    marginTop: 8,
                    marginBottom: 0,
                  },
                ]}
              >
                <MaterialIcons name="group-add" size={20} color="#B45309" />
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13,
                    lineHeight: 18,
                    color: colorScheme === 'dark' ? '#FDE68A' : '#92400E',
                  }}
                >
                  You don't follow any teams yet. Follow a team from the Explore tab to pitch an
                  event.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Team — single dropdown from followed teams (coach game events only) */}
        {isGameEvent && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Team *</Text>
            <Pressable
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.selectedTeam ? '#DC2626' : Colors[colorScheme].border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                },
              ]}
              onPress={() => setShowTeamPicker(true)}
            >
              <Text
                style={[
                  {
                    color: selectedTeam ? Colors[colorScheme].text : Colors[colorScheme].mutedText,
                  },
                ]}
              >
                {selectedTeam || 'Select a team'}
              </Text>
              <MaterialIcons name="expand-more" size={20} color={Colors[colorScheme].mutedText} />
            </Pressable>
            {errors.selectedTeam && <Text style={styles.errorText}>{errors.selectedTeam}</Text>}
          </View>
        )}

        {/* Opponent — autocomplete from database with manual fallback */}
        {isGameEvent && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Opponent *</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.opponent ? '#DC2626' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              placeholder="Search for a team or type a name"
              placeholderTextColor={Colors[colorScheme].mutedText}
              value={opponent}
              onChangeText={handleOpponentChange}
              autoCapitalize="words"
            />
            {opponentSearching && (
              <ActivityIndicator
                size="small"
                style={{ position: 'absolute', right: 28, top: 44 }}
                color={Colors[colorScheme].mutedText}
              />
            )}
            {opponentSuggestions.length > 0 && (
              <View
                style={[
                  styles.suggestionsBox,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                {opponentSuggestions.map(t => (
                  <Pressable
                    key={t.id}
                    style={[
                      styles.suggestionItem,
                      { borderBottomColor: Colors[colorScheme].border },
                    ]}
                    onPress={() => {
                      setOpponent(t.name);
                      setOpponentTeamId(String(t.id));
                      setOpponentSuggestions([]);
                      setErrors(prev => ({ ...prev, opponent: '' }));
                    }}
                  >
                    <MaterialIcons name="group" size={16} color={Colors[colorScheme].mutedText} />
                    <Text style={[styles.suggestionText, { color: Colors[colorScheme].text }]}>
                      {t.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            {errors.opponent && <Text style={styles.errorText}>{errors.opponent}</Text>}
          </View>
        )}

        {/* Game Type (Home/Away) — coach game events only */}
        {isGameEvent && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Game Type</Text>
            <View style={styles.gameTypeRow}>
              <Pressable
                style={[
                  styles.gameTypeButton,
                  {
                    backgroundColor:
                      gameType === 'home' ? Colors[colorScheme].tint : Colors[colorScheme].card,
                    borderColor:
                      gameType === 'home' ? Colors[colorScheme].tint : Colors[colorScheme].border,
                  },
                ]}
                onPress={() => {
                  setGameType('home');
                  setLocationTouched(false);
                }}
              >
                <MaterialIcons
                  name="home"
                  size={20}
                  color={gameType === 'home' ? '#fff' : Colors[colorScheme].text}
                />
                <Text
                  style={[
                    styles.gameTypeText,
                    { color: gameType === 'home' ? '#fff' : Colors[colorScheme].text },
                  ]}
                >
                  Home Game
                </Text>
              </Pressable>

              <Pressable
                style={[
                  styles.gameTypeButton,
                  {
                    backgroundColor:
                      gameType === 'away' ? Colors[colorScheme].tint : Colors[colorScheme].card,
                    borderColor:
                      gameType === 'away' ? Colors[colorScheme].tint : Colors[colorScheme].border,
                  },
                ]}
                onPress={() => {
                  setGameType('away');
                  setLocationTouched(false);
                }}
              >
                <MaterialIcons
                  name="flight"
                  size={20}
                  color={gameType === 'away' ? '#fff' : Colors[colorScheme].text}
                />
                <Text
                  style={[
                    styles.gameTypeText,
                    { color: gameType === 'away' ? '#fff' : Colors[colorScheme].text },
                  ]}
                >
                  Away Game
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Description */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
            {isCoach ? 'Description' : 'Tell us about your idea'}
          </Text>
          <TextInput
            style={[
              styles.textArea,
              {
                backgroundColor: Colors[colorScheme].card,
                borderColor: Colors[colorScheme].border,
                color: Colors[colorScheme].text,
              },
            ]}
            placeholder={
              isCoach
                ? 'Describe your event...'
                : "What's the event about? Who should come? Any details a reviewer should know?"
            }
            placeholderTextColor={Colors[colorScheme].mutedText}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Event Photo</Text>
          <Text style={[styles.bannerHelperText, { color: Colors[colorScheme].mutedText }]}>
            Upload a custom photo or keep the generated banner so this event never lands with a
            blank card.
          </Text>

          {bannerUrl ? (
            <View
              style={[
                styles.bannerCard,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Image
                source={{ uri: optimizeImageUrl(bannerUrl, 1200) }}
                style={styles.customBannerImage}
                resizeMode="cover"
              />
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
                    {uploadingBanner ? 'Uploading...' : 'Change Photo'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.bannerSecondaryButton,
                    { borderColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => setBannerUrl(null)}
                  disabled={uploadingBanner}
                >
                  <MaterialIcons name="delete-outline" size={16} color={Colors[colorScheme].text} />
                  <Text
                    style={[styles.bannerSecondaryButtonText, { color: Colors[colorScheme].text }]}
                  >
                    Use Generated
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View
              style={[
                styles.bannerCard,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <ViewShot ref={bannerCaptureRef} options={{ format: 'png', quality: 0.9 }}>
                <MatchBanner
                  leftImage={previewBanner.leftImage || undefined}
                  rightImage={previewBanner.rightImage || undefined}
                  leftName={previewBanner.leftName}
                  rightName={previewBanner.rightName}
                  height={160}
                  variant="compact"
                  appearance={appearance}
                />
              </ViewShot>
              <View style={styles.bannerActionRow}>
                <Pressable
                  style={[
                    styles.bannerPrimaryButton,
                    { backgroundColor: Colors[colorScheme].tint },
                  ]}
                  onPress={showBannerOptions}
                  disabled={uploadingBanner}
                >
                  <MaterialIcons name="cloud-upload" size={16} color="#FFFFFF" />
                  <Text style={styles.bannerPrimaryButtonText}>
                    {uploadingBanner ? 'Uploading...' : 'Upload Custom Photo'}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        {/* Date & Time */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Date & Time *</Text>
          <View style={styles.dateTimeRow}>
            <Pressable
              style={[
                styles.dateTimeButton,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.date ? '#DC2626' : Colors[colorScheme].border,
                },
              ]}
              onPress={() => setShowDatePicker(true)}
            >
              <MaterialIcons name="event" size={20} color={Colors[colorScheme].mutedText} />
              <Text style={[styles.dateTimeText, { color: Colors[colorScheme].text }]}>
                {date.toLocaleDateString()}
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.dateTimeButton,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
              onPress={() => setShowTimePicker(true)}
            >
              <MaterialIcons name="access-time" size={20} color={Colors[colorScheme].mutedText} />
              <Text style={[styles.dateTimeText, { color: Colors[colorScheme].text }]}>
                {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </Pressable>
          </View>
          {errors.date && <Text style={styles.errorText}>{errors.date}</Text>}
        </View>

        {showDatePicker && (
          <DateTimePicker
            value={date}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleDateChange}
            minimumDate={new Date()}
          />
        )}

        {showTimePicker && (
          <DateTimePicker
            value={date}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleTimeChange}
          />
        )}

        {/* Location with Google Maps Autocomplete */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Location *</Text>
          <View style={styles.locationFieldWrapper}>
            <TextInput
              ref={locationInputRef}
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.location ? '#DC2626' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              placeholder="Start typing an address, venue, or city"
              placeholderTextColor={Colors[colorScheme].mutedText}
              value={location}
              onChangeText={handleLocationChange}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
            />
            {locationQuerying && (
              <ActivityIndicator
                size="small"
                color={Colors[colorScheme].tint}
                style={styles.locationSpinner}
              />
            )}
            {locationSuggestions.length > 0 && (
              <View
                style={[
                  styles.locationSuggestionList,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                {locationSuggestions.map((suggestion, index) => (
                  <Pressable
                    key={suggestion.place_id}
                    style={[
                      styles.locationSuggestionItem,
                      { borderBottomColor: Colors[colorScheme].border },
                      index === locationSuggestions.length - 1 && styles.locationSuggestionItemLast,
                    ]}
                    onPress={() => handleSelectLocation(suggestion)}
                  >
                    <MaterialIcons
                      name="location-on"
                      size={16}
                      color={Colors[colorScheme].tint}
                      style={{ marginRight: 8 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[styles.locationSuggestionMain, { color: Colors[colorScheme].text }]}
                      >
                        {suggestion.structured_formatting?.main_text || suggestion.description}
                      </Text>
                      {suggestion.structured_formatting?.secondary_text && (
                        <Text
                          style={[
                            styles.locationSuggestionSecondary,
                            { color: Colors[colorScheme].mutedText },
                          ]}
                        >
                          {suggestion.structured_formatting.secondary_text}
                        </Text>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
          {errors.location && <Text style={styles.errorText}>{errors.location}</Text>}
          {!selectedPlace &&
            locationTouched &&
            location.length >= 3 &&
            locationSuggestions.length === 0 &&
            !locationQuerying && (
              <Text style={[styles.inputHelperText, { color: Colors[colorScheme].mutedText }]}>
                Tip: Select a suggested location for better accuracy, or continue typing to enter
                manually
              </Text>
            )}
        </View>

        {/* Info Box */}
        <View
          style={[
            styles.infoBox,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
        >
          <MaterialIcons name="info" size={20} color={Colors[colorScheme].tint} />
          <Text style={[styles.infoText, { color: Colors[colorScheme].mutedText }]}>
            {isCoach
              ? 'Your event will be reviewed before appearing publicly.'
              : "Event pitches are reviewed by coaches or admins. You'll be notified once it's approved."}
          </Text>
        </View>

        {/* Submit Button */}
        <Pressable
          style={[
            styles.submitButton,
            { backgroundColor: Colors[colorScheme].tint },
            (submitting || eventLimitReached || uploadingBanner) && styles.submitButtonDisabled,
          ]}
          onPress={handleSubmit}
          disabled={submitting || eventLimitReached || uploadingBanner}
        >
          {submitting || uploadingBanner ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitButtonText}>
              {eventLimitReached
                ? 'Event Limit Reached'
                : isCoach
                  ? 'Create Event'
                  : 'Submit Pitch'}
            </Text>
          )}
        </Pressable>

        <View style={{ height: 40 }} />
      </KeyboardAwareScreen>

      {/* Team Picker Modal — single dropdown of followed teams */}
      <Modal
        visible={showTeamPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTeamPicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <View
            style={[styles.pickerContainer, { backgroundColor: Colors[colorScheme].background }]}
          >
            <View style={styles.pickerHeader}>
              <Pressable onPress={() => setShowTeamPicker(false)}>
                <Text style={[styles.pickerHeaderButton, { color: Colors[colorScheme].text }]}>
                  Cancel
                </Text>
              </Pressable>
              <Text style={[styles.pickerTitle, { color: Colors[colorScheme].text }]}>
                Select Team
              </Text>
              <View style={{ width: 50 }} />
            </View>
            <ScrollView style={styles.pickerList}>
              {teams.length === 0 && (
                <View style={styles.noResultsContainer}>
                  <Text style={[styles.noResultsText, { color: Colors[colorScheme].mutedText }]}>
                    No followed teams found. Follow a team first.
                  </Text>
                </View>
              )}
              {teams.map(team => (
                <Pressable
                  key={team.id}
                  style={[
                    styles.pickerItem,
                    { borderBottomColor: Colors[colorScheme].border },
                    selectedTeam === team.name && { backgroundColor: Colors[colorScheme].surface },
                  ]}
                  onPress={() => {
                    setSelectedTeam(team.name);
                    setSelectedTeamId(team.id);
                    setShowTeamPicker(false);
                    setLocationTouched(false);
                  }}
                >
                  <View style={styles.pickerItemContent}>
                    {team.logo && (
                      <Image
                        source={{ uri: optimizeImageUrl(team.logo, 160) }}
                        style={styles.teamLogo}
                      />
                    )}
                    <Text style={[styles.pickerItemText, { color: Colors[colorScheme].text }]}>
                      {team.name}
                    </Text>
                  </View>
                  {selectedTeam === team.name && (
                    <MaterialIcons name="check" size={20} color={Colors[colorScheme].tint} />
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Pitch Team Picker Modal (for fan event pitches) — full-height sheet
          with search over the user's followed teams (device-testing feedback:
          the old bottom picker sat too low and had no search) */}
      <Modal
        visible={showPitchTeamPicker}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowPitchTeamPicker(false);
          setPitchTeamQuery('');
        }}
      >
        <View style={[styles.pickerSheet, { backgroundColor: Colors[colorScheme].background }]}>
          <View style={styles.pickerHeader}>
            <Pressable
              onPress={() => {
                setShowPitchTeamPicker(false);
                setPitchTeamQuery('');
              }}
            >
              <Text style={[styles.pickerHeaderButton, { color: Colors[colorScheme].text }]}>
                Cancel
              </Text>
            </Pressable>
            <Text style={[styles.pickerTitle, { color: Colors[colorScheme].text }]}>
              Select Team
            </Text>
            <View style={{ width: 50 }} />
          </View>
          <View style={styles.pickerSearchWrap}>
            <View
              style={[
                styles.pickerSearchRow,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <MaterialIcons name="search" size={20} color={Colors[colorScheme].mutedText} />
              <TextInput
                style={[styles.pickerSearchInput, { color: Colors[colorScheme].text }]}
                placeholder="Search teams you follow..."
                placeholderTextColor={Colors[colorScheme].mutedText}
                value={pitchTeamQuery}
                onChangeText={setPitchTeamQuery}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {pitchTeamQuery.length > 0 && (
                <Pressable onPress={() => setPitchTeamQuery('')} hitSlop={8}>
                  <MaterialIcons name="cancel" size={20} color={Colors[colorScheme].mutedText} />
                </Pressable>
              )}
            </View>
          </View>
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            {teams.length === 0 && (
              <View style={styles.noResultsContainer}>
                <Text style={[styles.noResultsText, { color: Colors[colorScheme].mutedText }]}>
                  No followed teams found. Follow a team first to pitch an event.
                </Text>
              </View>
            )}
            {teams.length > 0 && filteredPitchTeams.length === 0 && (
              <View style={styles.noResultsContainer}>
                <Text style={[styles.noResultsText, { color: Colors[colorScheme].mutedText }]}>
                  No followed teams match "{pitchTeamQuery.trim()}".
                </Text>
              </View>
            )}
            {filteredPitchTeams.map(team => (
              <Pressable
                key={team.id}
                style={[
                  styles.pickerItem,
                  { borderBottomColor: Colors[colorScheme].border },
                  pitchTeamId === team.id && { backgroundColor: Colors[colorScheme].surface },
                ]}
                onPress={() => {
                  setPitchTeamId(team.id);
                  setPitchTeamName(team.name);
                  setShowPitchTeamPicker(false);
                  setPitchTeamQuery('');
                }}
              >
                <View style={styles.pickerItemContent}>
                  {team.logo && (
                    <Image
                      source={{ uri: optimizeImageUrl(team.logo, 160) }}
                      style={styles.teamLogo}
                    />
                  )}
                  <Text style={[styles.pickerItemText, { color: Colors[colorScheme].text }]}>
                    {team.name}
                  </Text>
                </View>
                {pitchTeamId === team.id && (
                  <MaterialIcons name="check" size={20} color={Colors[colorScheme].tint} />
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

export default CreateFanEventScreen;
