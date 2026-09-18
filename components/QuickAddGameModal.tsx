import { uploadFile } from '@/api/upload';
// @ts-ignore JS exports
import { Team } from '@/api/entities';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { buildTeamPickerSports } from '@/utils/teamPickerCascade';
import { useManagedTeamOptions } from '@/hooks/useManagedTeamOptions';
import { useTeamOptions } from '@/hooks/useTeamOptions';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import { formatGameTime, isPastGameDate } from '@/utils/gameFormHelpers';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { pickerMediaTypesProp } from '@/utils/picker';
import { toUserMessage } from '@/utils/toUserMessage';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { getApiBaseUrl } from '../apiclient/http';
import MatchBanner from '../app/components/MatchBanner';
import { AppearancePreset } from './AppearancePicker';
import ImageEditor from './ImageEditor';
import LocationPicker from './LocationPicker';
import { styles } from './QuickAddGameModal.styles';

interface QuickAddGameModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (gameData: QuickGameData) => void;
  currentTeamName?: string; // Optional current team context
  currentTeamId?: string; // Current team ID for database relation
  userRole?: 'fan' | 'coach'; // User role to customize defaults
  initialData?: {
    id?: string;
    opponent: string;
    date: string;
    time: string;
    type: 'home' | 'away';
    banner_url?: string;
    appearance?: string;
    status?: string;
    location?: string | null;
  };
}

export type EventType =
  | 'game'
  | 'fundraiser'
  | 'watch_party'
  | 'team_trip'
  | 'meeting'
  | 'team_meal'
  | 'other';

export interface QuickGameData {
  id?: string; // Add id for editing
  currentTeam: string;
  currentTeamId?: string; // Team ID for database relation
  opponent: string;
  opponentTeamId?: string; // Opponent team ID for database relation
  date: string; // Will be today + some days
  time: string; // Selected time
  type: 'home' | 'away';
  banner_url?: string; // Add banner URL support
  cover_image_url?: string; // Add cover image URL support
  appearance?: string; // Add appearance support
  isCompetitive?: boolean; // Whether this is a competitive game or general event
  expectedAttendance?: number; // Expected number of attendees
  eventType?: EventType; // Type of event (game, fundraiser, watch_party, etc.)
  description?: string; // Event description
  // Event type-specific fields
  donationGoal?: number; // For fundraisers
  watchLocation?: string; // For watch parties
  watchLocationLat?: number; // Watch party location latitude
  watchLocationLng?: number; // Watch party location longitude
  watchLocationPlaceId?: string; // Watch party location place ID
  destination?: string; // For team trips
  // Game venue fields
  homeVenue?: string; // Home game venue name
  homeVenueLat?: number; // Home game venue latitude
  homeVenueLng?: number; // Home game venue longitude
  awayVenue?: string; // Away game venue name
  awayVenueLat?: number; // Away game venue latitude
  awayVenueLng?: number; // Away game venue longitude
  mapsUrl?: string; // Google Maps URL for the venue
}

export interface BuildQuickGameDataParams {
  id?: string;
  isCompetitive: boolean;
  currentTeam: string;
  eventTitle: string;
  currentTeamId?: string;
  opponent: string;
  opponentTeamId?: string;
  formattedDate: string;
  formattedTime: string;
  gameType: 'home' | 'away';
  expectedAttendance?: number;
  eventType: EventType;
  eventDescription?: string;
  donationGoal?: number;
  watchLocation?: string;
  watchLocationLat?: number;
  watchLocationLng?: number;
  watchLocationPlaceId?: string;
  destination?: string;
  homeVenue?: string;
  homeVenueLat?: number;
  homeVenueLng?: number;
  awayVenue?: string;
  awayVenueLat?: number;
  awayVenueLng?: number;
}

export function buildQuickGameData({
  id,
  isCompetitive,
  currentTeam,
  eventTitle,
  currentTeamId,
  opponent,
  opponentTeamId,
  formattedDate,
  formattedTime,
  gameType,
  expectedAttendance,
  eventType,
  eventDescription,
  donationGoal,
  watchLocation,
  watchLocationLat,
  watchLocationLng,
  watchLocationPlaceId,
  destination,
  homeVenue,
  homeVenueLat,
  homeVenueLng,
  awayVenue,
  awayVenueLat,
  awayVenueLng,
}: BuildQuickGameDataParams): QuickGameData {
  const trimmedCurrentTeam = isCompetitive ? currentTeam.trim() : eventTitle.trim();
  const trimmedOpponent = isCompetitive ? opponent.trim() : '';
  const trimmedWatchLocation = watchLocation?.trim();
  const trimmedDestination = destination?.trim();
  const trimmedHomeVenue = homeVenue?.trim();
  const trimmedAwayVenue = awayVenue?.trim();
  const parsedDescription = eventDescription?.trim();

  return {
    id,
    currentTeam: trimmedCurrentTeam,
    currentTeamId: currentTeamId || '',
    opponent: trimmedOpponent,
    opponentTeamId: isCompetitive ? opponentTeamId || '' : '',
    date: formattedDate,
    time: formattedTime,
    type: gameType,
    isCompetitive,
    expectedAttendance,
    eventType: isCompetitive ? 'game' : eventType,
    description: parsedDescription || undefined,
    donationGoal,
    watchLocation: trimmedWatchLocation || undefined,
    watchLocationLat,
    watchLocationLng,
    watchLocationPlaceId,
    destination: trimmedDestination || undefined,
    homeVenue: trimmedHomeVenue || undefined,
    homeVenueLat,
    homeVenueLng,
    awayVenue: trimmedAwayVenue || undefined,
    awayVenueLat,
    awayVenueLng,
    mapsUrl:
      gameType === 'away' && typeof awayVenueLat === 'number' && typeof awayVenueLng === 'number'
        ? `https://maps.google.com/?q=${awayVenueLat},${awayVenueLng}`
        : undefined,
  };
}

type TeamOption = {
  id: string;
  name: string;
  logo?: string;
  venue_address?: string | null;
  venue_lat?: number | null;
  venue_lng?: number | null;
  venue_place_id?: string | null;
};

const EVENT_TYPES: {
  value: EventType;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  description: string;
}[] = [
  {
    value: 'game',
    label: 'Game/Match',
    icon: 'trophy-outline',
    description: 'Competitive sports game',
  },
  {
    value: 'fundraiser',
    label: 'Fundraiser',
    icon: 'cash-outline',
    description: 'Fundraising event',
  },
  {
    value: 'watch_party',
    label: 'Watch Party',
    icon: 'tv-outline',
    description: 'Watch game together',
  },
  {
    value: 'team_trip',
    label: 'Team Trip',
    icon: 'bus-outline',
    description: 'Travel or field trip',
  },
  {
    value: 'meeting',
    label: 'Meeting',
    icon: 'people-outline',
    description: 'Team meeting or practice',
  },
  {
    value: 'team_meal',
    label: 'Team Meal',
    icon: 'restaurant-outline',
    description: 'Team dinner or lunch',
  },
  {
    value: 'other',
    label: 'Other',
    icon: 'ellipsis-horizontal-outline',
    description: 'Other event type',
  },
];

export default function QuickAddGameModal({
  visible,
  onClose,
  onSave,
  currentTeamName,
  currentTeamId,
  userRole = 'fan',
  initialData,
}: QuickAddGameModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  // `rawTeams` is the PUBLIC directory — it backs opponent suggestions only.
  // The "your team" picker must use teams the user can actually act for.
  const { teams: rawTeams } = useTeamOptions(true);
  const { teams: rawManagedTeams } = useManagedTeamOptions(true);

  const [showCurrentTeamPicker, setShowCurrentTeamPicker] = useState(false);
  const [showOpponentPicker, setShowOpponentPicker] = useState(false);

  const [currentTeam, setCurrentTeam] = useState(currentTeamName || 'My Team');
  const [storedCurrentTeamId, setStoredCurrentTeamId] = useState(currentTeamId || '');
  const [opponent, setOpponent] = useState('');
  const [opponentTeamId, setOpponentTeamId] = useState('');
  const [opponentSearchText, setOpponentSearchText] = useState('');
  const [opponentSearchResults, setOpponentSearchResults] = useState<TeamOption[]>([]);
  const [opponentSearchLoading, setOpponentSearchLoading] = useState(false);
  const opponentSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // Default to next week
  const [selectedTime, setSelectedTime] = useState(new Date(new Date().setHours(19, 0, 0, 0))); // Default to 7:00 PM
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [gameType, setGameType] = useState<'home' | 'away'>('home');
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const viewShotRef = useRef<any>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [editingImageUri, setEditingImageUri] = useState<string | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [uploadingCustomBanner, setUploadingCustomBanner] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreset>('classic');
  const [submitting, setSubmitting] = useState(false);

  // New state for competitive toggle and attendance
  const [isCompetitive, setIsCompetitive] = useState(true); // Default to competitive game
  const [expectedAttendance, setExpectedAttendance] = useState('');
  // Set default event type based on user role
  const getDefaultEventType = (role: string): EventType => {
    switch (role) {
      case 'coach':
        return 'game';
      case 'fan':
      default:
        return 'watch_party';
    }
  };

  const [eventType, setEventType] = useState<EventType>(getDefaultEventType(userRole));
  const [eventTitle, setEventTitle] = useState(''); // For non-competitive events
  const [eventDescription, setEventDescription] = useState(''); // Event description

  // Event type-specific fields
  const [donationGoal, setDonationGoal] = useState('');
  const [watchLocation, setWatchLocation] = useState('');
  const [watchLocationLat, setWatchLocationLat] = useState<number | undefined>();
  const [watchLocationLng, setWatchLocationLng] = useState<number | undefined>();
  const [watchLocationPlaceId, setWatchLocationPlaceId] = useState<string | undefined>();

  // Game venue state
  const [homeVenue, setHomeVenue] = useState('');
  const [homeVenueLat, setHomeVenueLat] = useState<number | undefined>();
  const [homeVenueLng, setHomeVenueLng] = useState<number | undefined>();
  const [awayVenue, setAwayVenue] = useState('');
  const [awayVenueLat, setAwayVenueLat] = useState<number | undefined>();
  const [awayVenueLng, setAwayVenueLng] = useState<number | undefined>();
  const [destination, setDestination] = useState('');
  const [homeVenueLocked, setHomeVenueLocked] = useState(true);

  const liveStatus = initialData?.status ? String(initialData.status).toLowerCase() : '';
  const isLiveEventEdit = Boolean(
    initialData?.id && (liveStatus === 'live' || liveStatus === 'in-progress')
  );
  const renderLockedSection = (content: ReactNode) =>
    isLiveEventEdit ? (
      <View style={[styles.lockedSection, { pointerEvents: 'none' }]} testID="live-edit-locked">
        {content}
      </View>
    ) : (
      <>{content}</>
    );

  // Update current team when prop changes or modal opens
  useEffect(() => {
    if (visible) {
      if (currentTeamName) {
        setCurrentTeam(currentTeamName);
      }
      if (currentTeamId) {
        setStoredCurrentTeamId(currentTeamId);
      }
    }
  }, [currentTeamName, currentTeamId, visible]);

  // Populate form when editing (initialData provided)
  useEffect(() => {
    if (initialData && visible) {
      setOpponent(initialData.opponent || '');
      setGameType(initialData.type || 'home');
      setBannerUrl(initialData.banner_url || null);
      setAppearance((initialData.appearance as AppearancePreset) || 'classic');
      if (initialData.location) {
        if ((initialData.type || 'home') === 'home') {
          setHomeVenue(initialData.location);
        } else {
          setAwayVenue(initialData.location);
        }
      }

      // Parse date
      if (initialData.date) {
        const dateParts = initialData.date.split('/');
        if (dateParts.length === 3) {
          const [month, day, year] = dateParts;
          setSelectedDate(new Date(parseInt(year), parseInt(month) - 1, parseInt(day)));
        }
      }

      // Parse time
      if (initialData.time) {
        const timeMatch = initialData.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const period = timeMatch[3].toUpperCase();

          if (period === 'PM' && hours !== 12) hours += 12;
          if (period === 'AM' && hours === 12) hours = 0;

          const timeDate = new Date();
          timeDate.setHours(hours, minutes, 0, 0);
          setSelectedTime(timeDate);
        }
      }
    } else if (!visible) {
      // Reset form when modal closes
      setOpponent('');
      setGameType('home');
      setBannerUrl(null);
      setAppearance('classic');
      setSelectedDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      setSelectedTime(new Date(new Date().setHours(19, 0, 0, 0)));
      setErrors({});
      setHomeVenue('');
      setHomeVenueLat(undefined);
      setHomeVenueLng(undefined);
      setAwayVenue('');
      setAwayVenueLat(undefined);
      setAwayVenueLng(undefined);
    }
  }, [initialData, visible]);

  const teams: TeamOption[] = useMemo(() => {
    if (!Array.isArray(rawTeams) || rawTeams.length === 0) {
      return [{ id: 'my-team', name: currentTeamName || 'My Team' }];
    }
    return rawTeams.map((team: any) => ({
      id: String(team.id),
      name: team.name,
      logo: team.logo_url || team.avatar_url,
      venue_address: team.venue_address,
      venue_lat: team.venue_lat,
      venue_lng: team.venue_lng,
      venue_place_id: team.venue_place_id,
    }));
  }, [currentTeamName, rawTeams]);

  // The user's OWN teams — the only valid answers to "Select Your Team".
  const myTeams: TeamOption[] = useMemo(() => {
    if (!Array.isArray(rawManagedTeams) || rawManagedTeams.length === 0) {
      return currentTeamName ? [{ id: currentTeamId || 'my-team', name: currentTeamName }] : [];
    }
    return rawManagedTeams.map((team: any) => ({
      id: String(team.id),
      name: team.name,
      logo: team.logo_url || team.avatar_url,
      venue_address: team.venue_address,
      venue_lat: team.venue_lat,
      venue_lng: team.venue_lng,
      venue_place_id: team.venue_place_id,
    }));
  }, [currentTeamName, currentTeamId, rawManagedTeams]);

  // Sport -> sub-team cascade for the "Select Your Team" picker. Teams in one
  // sport (basketball) are sibling level teams (boys/JV, girls/varsity); the
  // picker asks for the sport first, then the level team, and skips the second
  // step for single-team sports.
  const pickerSports = useMemo(() => {
    const source =
      Array.isArray(rawManagedTeams) && rawManagedTeams.length > 0
        ? rawManagedTeams.map((t: any) => ({
            id: String(t.id),
            name: t.name,
            sport: t.sport ?? null,
            program_id: t.program_id ?? null,
            level: t.level ?? null,
            gender: t.gender ?? null,
          }))
        : currentTeamName
          ? [{ id: currentTeamId || 'my-team', name: currentTeamName, program_id: null }]
          : [];
    return buildTeamPickerSports(source);
  }, [rawManagedTeams, currentTeamName, currentTeamId]);
  // Which sport the picker has drilled into (null = showing the sport list).
  const [pickerSportKey, setPickerSportKey] = useState<string | null>(null);
  const activePickerSport = pickerSports.find(s => s.key === pickerSportKey) ?? null;
  // Reset the drill-down whenever the picker closes so it always reopens at the
  // sport list.
  useEffect(() => {
    if (!showCurrentTeamPicker) setPickerSportKey(null);
  }, [showCurrentTeamPicker]);

  const selectPickerTeam = (teamId: string, teamName: string) => {
    setCurrentTeam(teamName);
    setStoredCurrentTeamId(teamId);
    if (errors.currentTeam) {
      setErrors(prev => ({ ...prev, currentTeam: '' }));
    }
    setShowCurrentTeamPicker(false);
    setPickerSportKey(null);
  };

  // Set home venue when current team changes or modal opens
  useEffect(() => {
    if (currentTeam && visible) {
      // Find the team data to get venue information
      const teamData = myTeams.find(t => t.name === currentTeam);

      if (teamData?.venue_address) {
        // Use actual team venue from database
        setHomeVenue(teamData.venue_address);
        setHomeVenueLat(teamData.venue_lat || undefined);
        setHomeVenueLng(teamData.venue_lng || undefined);
      } else {
        // No saved venue — leave blank so LocationPicker is shown
        setHomeVenue('');
        setHomeVenueLat(undefined);
        setHomeVenueLng(undefined);
      }
      setHomeVenueLocked(true); // Re-lock whenever team changes
    }
  }, [currentTeam, visible, myTeams]);

  // Debounced search: queries the API for teams matching the typed text
  const handleOpponentSearchChange = (text: string) => {
    setOpponentSearchText(text);
    if (opponentSearchTimerRef.current) clearTimeout(opponentSearchTimerRef.current);
    const q = text.trim();
    if (!q) {
      setOpponentSearchResults([]);
      setOpponentSearchLoading(false);
      return;
    }
    // Set loading immediately so UI responds to typing
    setOpponentSearchLoading(true);
    opponentSearchTimerRef.current = setTimeout(async () => {
      try {
        const res = await Team.list(q, false, { limit: 20, excludeDemoLeagues: true });
        const results: TeamOption[] = (Array.isArray(res) ? res : [])
          .filter((t: any) => t.name !== currentTeam)
          .map((t: any) => ({
            id: String(t.id),
            name: t.name,
            logo: t.logo_url || t.avatar_url || undefined,
          }));
        setOpponentSearchResults(results);
      } catch {
        setOpponentSearchResults([]);
      } finally {
        setOpponentSearchLoading(false);
      }
    }, 300);
  };

  // Teams shown in the opponent picker:
  //  - Empty search → pre-loaded teams minus current team
  //  - Non-empty search → API results (populated by handleOpponentSearchChange)
  const displayedOpponentTeams: TeamOption[] = opponentSearchText.trim()
    ? opponentSearchResults
    : teams.filter(team => team.name !== currentTeam);

  // Get team logo by team name
  const getTeamLogo = (teamName: string) => {
    const team = teams.find(t => t.name === teamName);
    return team?.logo || null;
  };

  // Get the home and away teams based on game type
  const getHomeAwayTeams = () => {
    if (gameType === 'home') {
      return { homeTeam: currentTeam, awayTeam: opponent };
    } else {
      return { homeTeam: opponent, awayTeam: currentTeam };
    }
  };

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (isCompetitive) {
      // Competitive games need team selection
      if (!currentTeam.trim()) {
        newErrors.currentTeam = 'Team name is required';
      }
      if (!opponent.trim()) {
        newErrors.opponent = 'Opponent name is required';
      }
      // All games require a venue location
      if (gameType === 'away' && !awayVenue.trim()) {
        newErrors.awayVenue = 'Away venue location is required';
      }
      if (gameType === 'home' && !homeVenue.trim()) {
        newErrors.homeVenue = 'Home venue location is required';
      }
    } else {
      // Non-competitive events need event title
      if (!eventTitle.trim()) {
        newErrors.currentTeam = 'Event title is required';
      }
      // Location is mandatory for all non-competitive events
      if (eventType === 'watch_party' && !watchLocation.trim()) {
        newErrors.watchLocation = 'Watch location is required';
      } else if (eventType === 'team_trip' && !destination.trim()) {
        newErrors.destination = 'Destination is required';
      } else if (eventType !== 'watch_party' && eventType !== 'team_trip' && !homeVenue.trim()) {
        newErrors.homeVenue = 'Location is required';
      }
    }

    if (isPastGameDate(selectedDate)) {
      newErrors.date = 'Event date cannot be in the past';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validateForm() || submitting) {
      return;
    }

    const formattedDate = selectedDate.toISOString().split('T')[0];
    const formattedTime = formatGameTime(selectedTime);
    const parsedAttendance = expectedAttendance ? parseInt(expectedAttendance, 10) : undefined;
    const parsedDonationGoal = donationGoal ? parseFloat(donationGoal) : undefined;

    const baseGameData = buildQuickGameData({
      id: initialData?.id,
      isCompetitive,
      currentTeam,
      eventTitle,
      currentTeamId: storedCurrentTeamId || '',
      opponent,
      opponentTeamId,
      formattedDate,
      formattedTime,
      gameType,
      expectedAttendance: parsedAttendance,
      eventType: isCompetitive ? 'game' : eventType,
      eventDescription,
      donationGoal: parsedDonationGoal,
      watchLocation,
      watchLocationLat,
      watchLocationLng,
      watchLocationPlaceId,
      destination,
      homeVenue,
      homeVenueLat,
      homeVenueLng,
      awayVenue,
      awayVenueLat,
      awayVenueLng,
    });

    // If we already have a banner uploaded, include it. Otherwise attempt to capture & upload.
    const doSave = async () => {
      setSubmitting(true);
      try {
        let finalData: QuickGameData = {
          ...baseGameData,
          appearance: appearance,
        };

        // Priority: custom uploaded banner > auto-generated banner
        if (bannerUrl) {
          // User has uploaded a custom banner, use it directly
          finalData.banner_url = bannerUrl;
          finalData.cover_image_url = bannerUrl; // Also set cover_image_url to the same value
        } else if (isCompetitive && getHomeAwayTeams().homeTeam && getHomeAwayTeams().awayTeam) {
          // No custom banner, competitive game - try to capture the auto-generated preview and upload
          if (viewShotRef.current) {
            try {
              setUploadingBanner(true);
              const uri = await captureRef(viewShotRef, { format: 'png', quality: 0.9 });
              const uploaded = await uploadFile(
                getApiBaseUrl(),
                uri,
                'match-banner.png',
                'image/png'
              );
              const url = uploaded?.url || uploaded?.path || null;
              if (url) {
                finalData.banner_url = url;
                finalData.cover_image_url = url; // Also set cover_image_url to the same value
              }
            } catch (e) {
              if (__DEV__)
                console.warn('Banner capture/upload failed, continuing without banner', e);
            } finally {
              setUploadingBanner(false);
            }
          }
        }

        onSave(finalData);
        resetForm();
        onClose();
      } finally {
        setSubmitting(false);
      }
    };

    // run save (async allowed)
    void doSave();
  };

  const resetForm = () => {
    setCurrentTeam(currentTeamName || 'My Team');
    setOpponent('');
    setOpponentSearchText('');
    setSelectedDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    setSelectedTime(new Date(new Date().setHours(19, 0, 0, 0)));
    setGameType('home');
    setErrors({});
    setBannerUrl(null);
    setEditingImageUri(null);
    setUploadingCustomBanner(false);
    setIsCompetitive(true);
    setEventType('game');
    setExpectedAttendance('');
    setEventTitle('');
    setEventDescription('');
    setDonationGoal('');
    setWatchLocation('');
    setDestination('');
    setHomeVenueLocked(true);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const pickCustomBanner = async () => {
    try {
      const result = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (result.granted === false) {
        Alert.alert(
          'Permission Required',
          'Please allow access to your photos to upload a banner.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        );
        return;
      }

      const pickerResult = await ImagePicker.launchImageLibraryAsync({
        ...pickerMediaTypesProp(),
        allowsEditing: true,
        // Event cards render banners at 4:5 (app/feed.tsx FullBleedCardImage) —
        // crop at the displayed ratio so uploads aren't re-cropped at render time.
        aspect: [4, 5],
        quality: 0.9,
        exif: false,
      });

      if (!pickerResult.canceled && pickerResult.assets[0]) {
        const localUri = await materializeICloudAssetIfNeeded(pickerResult.assets[0].uri);
        await uploadCustomBanner(localUri);
      }
    } catch {
      Alert.alert('Error', 'Failed to pick image. Please try again.');
    }
  };

  const takeCustomBannerPhoto = async () => {
    try {
      const result = await ImagePicker.requestCameraPermissionsAsync();
      if (result.granted === false) {
        Alert.alert('Permission Required', 'Please allow camera access to take a banner photo.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
        return;
      }

      const pickerResult = await ImagePicker.launchCameraAsync({
        ...pickerMediaTypesProp(),
        allowsEditing: true,
        // Event cards render banners at 4:5 (app/feed.tsx FullBleedCardImage) —
        // crop at the displayed ratio so uploads aren't re-cropped at render time.
        aspect: [4, 5],
        quality: 0.9,
        exif: false,
      });

      if (!pickerResult.canceled && pickerResult.assets[0]) {
        const localUri = await materializeICloudAssetIfNeeded(pickerResult.assets[0].uri);
        await uploadCustomBanner(localUri);
      }
    } catch {
      Alert.alert('Error', 'Failed to take photo. Please try again.');
    }
  };

  const uploadCustomBanner = async (uri: string) => {
    setUploadingCustomBanner(true);
    try {
      // Upload using dynamic API base
      const uploaded = await uploadFile(getApiBaseUrl(), uri, 'custom-banner.jpg', 'image/jpeg');

      const url = uploaded?.url || uploaded?.path;

      if (url) {
        setBannerUrl(url);
      } else {
        throw new Error('Upload failed - no URL returned');
      }
    } catch (error: any) {
      Alert.alert(
        'Upload Failed',
        toUserMessage(error, 'Failed to upload banner. Please try again.')
      );
    } finally {
      setUploadingCustomBanner(false);
    }
  };

  const showCustomBannerOptions = () => {
    Alert.alert('Upload Custom Banner', 'Choose how you want to add your game banner', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Photo Library', onPress: pickCustomBanner },
      { text: 'Take Photo', onPress: takeCustomBannerPhoto },
    ]);
  };

  const removeCustomBanner = () => {
    Alert.alert(
      'Remove Custom Banner',
      'This will remove your custom banner and use the auto-generated one instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => setBannerUrl(null) },
      ]
    );
  };

  // True when the current team has a real saved venue address
  const teamHasVenue = !!teams.find(t => t.name === currentTeam)?.venue_address;

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleClose}
      >
        <View style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
          {/* Header */}
          <View
            style={[
              styles.header,
              {
                backgroundColor: Colors[colorScheme].background,
                borderBottomColor: Colors[colorScheme].border,
                paddingTop: insets.top,
              },
            ]}
          >
            <Pressable style={styles.headerButton} onPress={handleClose}>
              <Text style={[styles.headerButtonText, { color: Colors[colorScheme].text }]}>
                Cancel
              </Text>
            </Pressable>

            <Text style={[styles.headerTitle, { color: Colors[colorScheme].text }]}>
              {initialData ? 'Edit Event' : isCompetitive ? 'Add Game' : 'Add Event'}
            </Text>

            <Pressable
              style={[
                styles.headerButton,
                (uploadingBanner || submitting) && styles.headerButtonDisabled,
              ]}
              onPress={handleSave}
              disabled={uploadingBanner || submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
              ) : (
                <Text
                  style={[
                    styles.headerButtonText,
                    {
                      color: uploadingBanner
                        ? Colors[colorScheme].mutedText
                        : Colors[colorScheme].tint,
                    },
                  ]}
                >
                  {uploadingBanner ? 'Generating...' : initialData ? 'Save' : 'Add'}
                </Text>
              )}
            </Pressable>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View
              style={[
                styles.helpCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Ionicons name="flash-outline" size={20} color={Colors[colorScheme].tint} />
              <Text style={[styles.helpText, { color: Colors[colorScheme].mutedText }]}>
                Quick add with smart defaults. For more options, use Manual Entry.
              </Text>
            </View>

            {isLiveEventEdit && (
              <View
                style={[
                  styles.liveNotice,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                <Ionicons
                  name="alert-circle"
                  size={18}
                  color="#F97316"
                  style={styles.liveNoticeIcon}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.liveNoticeTitle, { color: Colors[colorScheme].text }]}>
                    Live Event Restrictions
                  </Text>
                  <Text
                    style={[styles.liveNoticeSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    While this event is live you can only adjust the date, time, or location — or
                    remove it entirely.
                  </Text>
                </View>
              </View>
            )}

            {renderLockedSection(
              <>
                {/* Competitive Game Toggle */}
                <View style={styles.formSection}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[styles.label, { color: Colors[colorScheme].text, marginBottom: 4 }]}
                      >
                        Competitive Game
                      </Text>
                      <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                        Toggle on if this event has an opponent team
                      </Text>
                    </View>
                    <Pressable
                      style={[
                        styles.toggle,
                        {
                          backgroundColor: isCompetitive ? '#10B981' : Colors[colorScheme].border,
                          justifyContent: isCompetitive ? 'flex-end' : 'flex-start',
                        },
                      ]}
                      onPress={() => {
                        const newValue = !isCompetitive;
                        setIsCompetitive(newValue);
                        // When toggling to competitive, set event type to game
                        if (newValue) {
                          setEventType('game');
                        } else {
                          // When toggling to non-competitive, default to first non-game type
                          setEventType('fundraiser');
                        }
                      }}
                    >
                      <View
                        style={[
                          styles.toggleThumb,
                          { backgroundColor: Colors[colorScheme].background },
                        ]}
                      />
                    </Pressable>
                  </View>
                </View>

                {/* Event Type Selector - Only show for non-competitive events */}
                {!isCompetitive && (
                  <View style={styles.formSection}>
                    <Text
                      style={[styles.label, { color: Colors[colorScheme].text, marginBottom: 12 }]}
                    >
                      Event Type
                    </Text>
                    <View style={styles.eventTypeGrid}>
                      {EVENT_TYPES.filter(et => et.value !== 'game').map(type => (
                        <Pressable
                          key={type.value}
                          style={[
                            styles.eventTypeCard,
                            {
                              backgroundColor:
                                eventType === type.value
                                  ? Colors[colorScheme].tint
                                  : Colors[colorScheme].surface,
                              borderColor:
                                eventType === type.value
                                  ? Colors[colorScheme].tint
                                  : Colors[colorScheme].border,
                            },
                          ]}
                          onPress={() => setEventType(type.value)}
                        >
                          <Ionicons
                            name={type.icon}
                            size={24}
                            color={eventType === type.value ? '#fff' : Colors[colorScheme].text}
                          />
                          <Text
                            style={[
                              styles.eventTypeLabel,
                              {
                                color: eventType === type.value ? '#fff' : Colors[colorScheme].text,
                              },
                            ]}
                          >
                            {type.label}
                          </Text>
                          <Text
                            style={[
                              styles.eventTypeDescription,
                              {
                                color:
                                  eventType === type.value
                                    ? 'rgba(255,255,255,0.8)'
                                    : Colors[colorScheme].mutedText,
                              },
                            ]}
                          >
                            {type.description}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}

                {/* Team/Event Selection - Different for competitive vs non-competitive */}
                {isCompetitive ? (
                  // Competitive: Show team picker
                  <View style={styles.formSection}>
                    <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                      Your Team
                    </Text>
                    <Pressable
                      style={[
                        styles.input,
                        {
                          backgroundColor: Colors[colorScheme].surface,
                          borderColor: errors.currentTeam ? '#EF4444' : Colors[colorScheme].border,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        },
                      ]}
                      onPress={() => setShowCurrentTeamPicker(true)}
                    >
                      <Text
                        style={[
                          {
                            color: currentTeam
                              ? Colors[colorScheme].text
                              : Colors[colorScheme].mutedText,
                          },
                        ]}
                      >
                        {currentTeam || 'Select your team'}
                      </Text>
                      <Ionicons
                        name="chevron-down"
                        size={20}
                        color={Colors[colorScheme].mutedText}
                      />
                    </Pressable>
                    {errors.currentTeam && (
                      <Text style={styles.errorText}>{errors.currentTeam}</Text>
                    )}
                  </View>
                ) : (
                  // Non-competitive: Show event title text field
                  <View style={styles.formSection}>
                    <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                      Event Title
                    </Text>
                    <TextInput
                      style={[
                        styles.input,
                        {
                          backgroundColor: Colors[colorScheme].surface,
                          borderColor: errors.currentTeam ? '#EF4444' : Colors[colorScheme].border,
                          color: Colors[colorScheme].text,
                        },
                      ]}
                      placeholder="e.g., Team Fundraiser BBQ, Watch Party"
                      placeholderTextColor={Colors[colorScheme].mutedText}
                      value={eventTitle}
                      onChangeText={setEventTitle}
                      maxLength={100}
                    />
                    {errors.currentTeam && (
                      <Text style={styles.errorText}>{errors.currentTeam}</Text>
                    )}
                    <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                      Give your event a descriptive name
                    </Text>
                  </View>
                )}

                {/* Event Description - Show for all events */}
                <View style={styles.formSection}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                    Description (Optional)
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: Colors[colorScheme].surface,
                        borderColor: Colors[colorScheme].border,
                        color: Colors[colorScheme].text,
                        minHeight: 80,
                        paddingTop: 12,
                        textAlignVertical: 'top',
                      },
                    ]}
                    placeholder="Add details about this event..."
                    placeholderTextColor={Colors[colorScheme].mutedText}
                    value={eventDescription}
                    onChangeText={setEventDescription}
                    multiline
                    numberOfLines={4}
                    maxLength={500}
                  />
                  <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                    {eventDescription.length}/500 characters
                  </Text>
                </View>

                {/* Opponent Team - Only show if competitive */}
                {isCompetitive && (
                  <View style={styles.formSection}>
                    <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                      Opponent Team
                    </Text>
                    <Pressable
                      style={[
                        styles.input,
                        {
                          backgroundColor: Colors[colorScheme].surface,
                          borderColor: errors.opponent ? '#EF4444' : Colors[colorScheme].border,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        },
                      ]}
                      onPress={() => setShowOpponentPicker(true)}
                    >
                      <Text
                        style={[
                          {
                            color: opponent
                              ? Colors[colorScheme].text
                              : Colors[colorScheme].mutedText,
                          },
                        ]}
                      >
                        {opponent || 'Select opponent team'}
                      </Text>
                      <Ionicons
                        name="chevron-down"
                        size={20}
                        color={Colors[colorScheme].mutedText}
                      />
                    </Pressable>
                    {errors.opponent && <Text style={styles.errorText}>{errors.opponent}</Text>}
                  </View>
                )}
              </>
            )}

            {/* Date and Time Selection */}
            <View style={{ flexDirection: 'row', marginBottom: 24 }}>
              <View style={[styles.formSection, { flex: 1, marginRight: 8, marginBottom: 0 }]}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Event Date</Text>
                <Pressable
                  style={[
                    styles.input,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: errors.date ? '#EF4444' : Colors[colorScheme].border,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    },
                  ]}
                  onPress={() => setShowDatePicker(true)}
                >
                  <Text style={[{ color: Colors[colorScheme].text }]}>
                    {selectedDate.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </Text>
                  <Ionicons
                    name="calendar-outline"
                    size={20}
                    color={Colors[colorScheme].mutedText}
                  />
                </Pressable>
                {errors.date && <Text style={styles.errorText}>{errors.date}</Text>}
              </View>

              <View style={[styles.formSection, { flex: 1, marginLeft: 8, marginBottom: 0 }]}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Event Time</Text>
                <Pressable
                  style={[
                    styles.input,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    },
                  ]}
                  onPress={() => setShowTimePicker(true)}
                >
                  <Text style={[{ color: Colors[colorScheme].text }]}>
                    {formatGameTime(selectedTime)}
                  </Text>
                  <Ionicons name="time-outline" size={20} color={Colors[colorScheme].mutedText} />
                </Pressable>
              </View>
            </View>

            {/* Game Type - Only show if competitive */}
            {isCompetitive &&
              renderLockedSection(
                <View style={styles.formSection}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Game Type</Text>
                  <View style={styles.gameTypeContainer}>
                    <Pressable
                      style={[
                        styles.gameTypeButton,
                        {
                          backgroundColor:
                            gameType === 'home'
                              ? Colors[colorScheme].tint
                              : Colors[colorScheme].surface,
                          borderColor:
                            gameType === 'home'
                              ? Colors[colorScheme].tint
                              : Colors[colorScheme].border,
                        },
                      ]}
                      onPress={() => setGameType('home')}
                    >
                      <Ionicons
                        name="home-outline"
                        size={16}
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
                            gameType === 'away'
                              ? Colors[colorScheme].tint
                              : Colors[colorScheme].surface,
                          borderColor:
                            gameType === 'away'
                              ? Colors[colorScheme].tint
                              : Colors[colorScheme].border,
                        },
                      ]}
                      onPress={() => setGameType('away')}
                    >
                      <Ionicons
                        name="airplane-outline"
                        size={16}
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

            {/* Venue Location - Show for competitive games */}
            {isCompetitive && (
              <View style={styles.formSection}>
                <View style={styles.labelWithIcon}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Venue</Text>
                  {gameType === 'home' && teamHasVenue && homeVenueLocked && (
                    <View style={styles.lockedBadge}>
                      <Ionicons
                        name="lock-closed"
                        size={12}
                        color={Colors[colorScheme].mutedText}
                      />
                      <Text style={[styles.lockedText, { color: Colors[colorScheme].mutedText }]}>
                        Locked
                      </Text>
                    </View>
                  )}
                </View>

                {gameType === 'home' ? (
                  /* Home Game — locked to team venue by default, unlockable per game */
                  teamHasVenue && homeVenueLocked ? (
                    /* Locked: show saved venue + "Change location" link */
                    <View>
                      <View
                        style={[
                          styles.lockedLocationContainer,
                          {
                            backgroundColor: Colors[colorScheme].surface,
                            borderColor: Colors[colorScheme].border,
                          },
                        ]}
                      >
                        <View style={styles.locationIconRow}>
                          <Ionicons name="home" size={20} color={Colors[colorScheme].mutedText} />
                          <Text
                            style={[
                              styles.lockedLocationText,
                              { color: Colors[colorScheme].mutedText },
                            ]}
                          >
                            {homeVenue}
                          </Text>
                        </View>
                      </View>
                      <Pressable
                        style={styles.changeLocationLink}
                        onPress={() => setHomeVenueLocked(false)}
                      >
                        <Ionicons
                          name="pencil-outline"
                          size={13}
                          color={Colors[colorScheme].tint}
                        />
                        <Text
                          style={[styles.changeLocationText, { color: Colors[colorScheme].tint }]}
                        >
                          Change location
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    /* Unlocked: LocationPicker + "Use team venue" restore link */
                    <View>
                      <LocationPicker
                        value={homeVenue}
                        onLocationSelect={location => {
                          setHomeVenue(location.address);
                          setHomeVenueLat(location.latitude);
                          setHomeVenueLng(location.longitude);
                        }}
                        placeholder="Search for venue location..."
                      />
                      {teamHasVenue && (
                        <Pressable
                          style={styles.changeLocationLink}
                          onPress={() => {
                            const td = teams.find(t => t.name === currentTeam);
                            if (td?.venue_address) {
                              setHomeVenue(td.venue_address);
                              setHomeVenueLat(td.venue_lat ?? undefined);
                              setHomeVenueLng(td.venue_lng ?? undefined);
                            }
                            setHomeVenueLocked(true);
                          }}
                        >
                          <Ionicons
                            name="arrow-undo-outline"
                            size={13}
                            color={Colors[colorScheme].tint}
                          />
                          <Text
                            style={[styles.changeLocationText, { color: Colors[colorScheme].tint }]}
                          >
                            Use team venue
                          </Text>
                        </Pressable>
                      )}
                      <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                        {teamHasVenue
                          ? 'Using a different location for this game.'
                          : 'Enter the venue address for this home game.'}
                      </Text>
                    </View>
                  )
                ) : (
                  /* Away Game - Editable with Google Maps */
                  <View>
                    <LocationPicker
                      value={awayVenue}
                      onLocationSelect={location => {
                        setAwayVenue(location.address);
                        setAwayVenueLat(location.latitude);
                        setAwayVenueLng(location.longitude);
                      }}
                      placeholder="Search for venue location..."
                    />
                    {awayVenue && awayVenueLat && awayVenueLng && (
                      <Pressable
                        style={[
                          styles.mapsLinkButton,
                          {
                            backgroundColor: Colors[colorScheme].surface,
                            borderColor: Colors[colorScheme].border,
                          },
                        ]}
                        onPress={() => {
                          const url = `https://maps.google.com/?q=${awayVenueLat},${awayVenueLng}`;
                          // Open in browser or maps app
                          Alert.alert('Open in Maps', 'This will open Google Maps', [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Open',
                              onPress: () => {
                                void Linking.openURL(url);
                              },
                            },
                          ]);
                        }}
                      >
                        <Ionicons name="map" size={16} color={Colors[colorScheme].tint} />
                        <Text style={[styles.mapsLinkText, { color: Colors[colorScheme].tint }]}>
                          View on Google Maps
                        </Text>
                      </Pressable>
                    )}
                    <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                      Required for away games. Search for the venue or drop a pin on the map.
                    </Text>
                    {errors.awayVenue && (
                      <Text style={[styles.errorText, { color: '#DC2626' }]}>
                        {errors.awayVenue}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            )}

            {/* Expected Attendance - Show for all events */}
            {renderLockedSection(
              <View style={styles.formSection}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                  Expected Attendance (Optional)
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                      color: Colors[colorScheme].text,
                    },
                  ]}
                  placeholder="e.g., 50"
                  placeholderTextColor={Colors[colorScheme].mutedText}
                  value={expectedAttendance}
                  onChangeText={setExpectedAttendance}
                  keyboardType="number-pad"
                  maxLength={4}
                />
              </View>
            )}

            {/* Event Type-Specific Fields */}
            {eventType === 'fundraiser' &&
              renderLockedSection(
                <View style={styles.formSection}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                    Fundraising Goal (Optional)
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: Colors[colorScheme].surface,
                        borderColor: Colors[colorScheme].border,
                        color: Colors[colorScheme].text,
                      },
                    ]}
                    placeholder="e.g., 1000"
                    placeholderTextColor={Colors[colorScheme].mutedText}
                    value={donationGoal}
                    onChangeText={setDonationGoal}
                    keyboardType="decimal-pad"
                  />
                  <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                    Target amount to raise ($)
                  </Text>
                </View>
              )}

            {eventType === 'watch_party' && (
              <View style={styles.formSection}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                  Watch Location *
                </Text>
                <LocationPicker
                  value={watchLocation}
                  onLocationSelect={location => {
                    setWatchLocation(location.address);
                    setWatchLocationLat(location.latitude);
                    setWatchLocationLng(location.longitude);
                    setWatchLocationPlaceId(location.placeId);
                  }}
                  placeholder="e.g., Sports Bar, Team House"
                />
                {errors.watchLocation && (
                  <Text style={styles.errorText}>{errors.watchLocation}</Text>
                )}
                <Text style={[styles.helperText, { color: Colors[colorScheme].mutedText }]}>
                  Where fans will gather to watch the game
                </Text>
              </View>
            )}

            {eventType === 'team_trip' && (
              <View style={styles.formSection}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                  Destination *
                </Text>
                <LocationPicker
                  value={destination}
                  onLocationSelect={location => {
                    setDestination(location.address);
                  }}
                  placeholder="e.g., State Tournament, Orlando FL"
                />
                {errors.destination && <Text style={styles.errorText}>{errors.destination}</Text>}
              </View>
            )}

            {/* Location for non-competitive events (fundraiser, meeting, team_meal, other) */}
            {!isCompetitive && eventType !== 'watch_party' && eventType !== 'team_trip' && (
              <View style={styles.formSection}>
                <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Location *</Text>
                <LocationPicker
                  value={homeVenue}
                  onLocationSelect={location => {
                    setHomeVenue(location.address);
                    setHomeVenueLat(location.latitude);
                    setHomeVenueLng(location.longitude);
                  }}
                  placeholder="e.g., School Gym, Community Center"
                />
                {errors.homeVenue && <Text style={styles.errorText}>{errors.homeVenue}</Text>}
              </View>
            )}

            {/* Enhanced Game Preview */}
            {currentTeam.trim() &&
              (!isCompetitive || opponent.trim()) &&
              !errors.currentTeam &&
              !errors.opponent &&
              !errors.date &&
              renderLockedSection(
                <View
                  style={[
                    styles.previewCard,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                >
                  <Text style={[styles.previewTitle, { color: Colors[colorScheme].text }]}>
                    {isCompetitive ? 'Game Preview' : 'Event Preview'}
                  </Text>

                  {/* Custom Banner Upload Section */}
                  <View style={styles.bannerUploadSection}>
                    <Text style={[styles.bannerUploadLabel, { color: Colors[colorScheme].text }]}>
                      {isCompetitive ? 'Game Banner' : 'Event Banner'}
                    </Text>

                    {bannerUrl ? (
                      // Show custom uploaded banner
                      <View style={styles.customBannerContainer}>
                        <Image
                          source={{ uri: optimizeImageUrl(bannerUrl, 1200) }}
                          style={styles.customBannerImage}
                          resizeMode="cover"
                        />
                        <View style={styles.customBannerActions}>
                          <Pressable
                            style={[
                              styles.bannerActionButton,
                              { backgroundColor: Colors[colorScheme].tint },
                            ]}
                            onPress={showCustomBannerOptions}
                            disabled={uploadingCustomBanner}
                          >
                            <Ionicons name="camera-outline" size={16} color="#fff" />
                            <Text style={styles.bannerActionText}>
                              {uploadingCustomBanner ? 'Uploading...' : 'Change'}
                            </Text>
                          </Pressable>
                          <Pressable
                            style={[styles.bannerActionButton, { backgroundColor: '#EF4444' }]}
                            onPress={removeCustomBanner}
                            disabled={uploadingCustomBanner}
                          >
                            <Ionicons name="trash-outline" size={16} color="#fff" />
                            <Text style={styles.bannerActionText}>Remove</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      // Show auto-generated banner with upload option
                      <View>
                        <View style={styles.matchupContainer}>
                          <ViewShot
                            ref={viewShotRef}
                            options={{ format: 'png', quality: 0.9 }}
                            style={{ width: '100%' }}
                          >
                            {/* Render MatchBanner so appearance and images are visible in the preview */}
                            <MatchBanner
                              leftImage={
                                isCompetitive
                                  ? getTeamLogo(getHomeAwayTeams().homeTeam) || undefined
                                  : undefined
                              }
                              rightImage={
                                isCompetitive
                                  ? getTeamLogo(getHomeAwayTeams().awayTeam) || undefined
                                  : undefined
                              }
                              leftName={
                                isCompetitive
                                  ? getHomeAwayTeams().homeTeam
                                  : eventTitle.trim() || 'Event'
                              }
                              rightName={
                                isCompetitive
                                  ? getHomeAwayTeams().awayTeam
                                  : EVENT_TYPES.find(t => t.value === eventType)?.label || 'Event'
                              }
                              height={240}
                              variant="compact"
                              leftColor={
                                isCompetitive
                                  ? (teams.find(t => t.name === getHomeAwayTeams().homeTeam) as any)
                                      ?.color
                                  : undefined
                              }
                              rightColor={
                                isCompetitive
                                  ? (teams.find(t => t.name === getHomeAwayTeams().awayTeam) as any)
                                      ?.color
                                  : undefined
                              }
                              appearance={appearance}
                            />
                          </ViewShot>
                        </View>

                        <View style={styles.bannerOptionsRow}>
                          <Pressable
                            style={[
                              styles.bannerOptionButton,
                              { backgroundColor: Colors[colorScheme].tint },
                            ]}
                            onPress={showCustomBannerOptions}
                            disabled={uploadingCustomBanner}
                          >
                            <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
                            <Text style={styles.bannerOptionText}>
                              {uploadingCustomBanner ? 'Uploading...' : 'Upload Custom'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </View>

                  {/* Game Details */}
                  <View
                    style={[styles.gameDetails, { borderTopColor: Colors[colorScheme].border }]}
                  >
                    <View style={styles.detailRow}>
                      <Ionicons
                        name="location-outline"
                        size={16}
                        color={Colors[colorScheme].mutedText}
                      />
                      <Text style={[styles.detailText, { color: Colors[colorScheme].mutedText }]}>
                        {gameType === 'home' ? 'Home Stadium' : 'Away Venue'}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Ionicons
                        name="calendar-outline"
                        size={16}
                        color={Colors[colorScheme].mutedText}
                      />
                      <Text style={[styles.detailText, { color: Colors[colorScheme].mutedText }]}>
                        {gameType === 'home' ? 'Home Game' : 'Away Game'}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

            <View style={styles.bottomSpacer} />
          </ScrollView>

          {/* Date/Time Pickers */}
          {showDatePicker && (
            <DateTimePicker
              value={selectedDate}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event, date) => {
                setShowDatePicker(false);
                if (date) {
                  setSelectedDate(date);
                  if (errors.date) {
                    setErrors(prev => ({ ...prev, date: '' }));
                  }
                }
              }}
              minimumDate={new Date()}
            />
          )}

          {showTimePicker && (
            <DateTimePicker
              value={selectedTime}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event, time) => {
                setShowTimePicker(false);
                if (time) {
                  setSelectedTime(time);
                }
              }}
            />
          )}

          {/* Current Team Picker Modal */}
          <Modal
            visible={showCurrentTeamPicker}
            transparent
            animationType="slide"
            onRequestClose={() => setShowCurrentTeamPicker(false)}
          >
            <View style={styles.pickerOverlay}>
              <View
                style={[
                  styles.pickerContainer,
                  { backgroundColor: Colors[colorScheme].background },
                ]}
              >
                <View style={styles.pickerHeader}>
                  <Pressable
                    onPress={() =>
                      activePickerSport ? setPickerSportKey(null) : setShowCurrentTeamPicker(false)
                    }
                  >
                    <Text style={[styles.pickerHeaderButton, { color: Colors[colorScheme].text }]}>
                      {activePickerSport ? 'Back' : 'Cancel'}
                    </Text>
                  </Pressable>
                  <Text style={[styles.pickerTitle, { color: Colors[colorScheme].text }]}>
                    {activePickerSport ? activePickerSport.label : 'Select Your Team'}
                  </Text>
                  <View style={{ width: 50 }} />
                </View>
                <ScrollView style={styles.pickerList}>
                  {activePickerSport
                    ? // Level 2: sub-teams within the chosen sport.
                      activePickerSport.teams.map(sub => {
                        const logo = myTeams.find(t => t.id === sub.id)?.logo;
                        return (
                          <Pressable
                            key={sub.id}
                            style={[
                              styles.pickerItem,
                              { borderBottomColor: Colors[colorScheme].border },
                              storedCurrentTeamId === sub.id && {
                                backgroundColor: Colors[colorScheme].surface,
                              },
                            ]}
                            onPress={() => selectPickerTeam(sub.id, sub.name)}
                          >
                            <View style={styles.pickerItemContent}>
                              <View style={styles.teamLogoContainer}>
                                {logo ? (
                                  <Image
                                    source={{ uri: optimizeImageUrl(logo, 160) }}
                                    style={styles.teamLogoImage}
                                  />
                                ) : (
                                  <Text style={styles.teamLogoText}>🏆</Text>
                                )}
                              </View>
                              <Text
                                style={[styles.pickerItemText, { color: Colors[colorScheme].text }]}
                              >
                                {sub.label}
                              </Text>
                            </View>
                            {storedCurrentTeamId === sub.id && (
                              <Ionicons name="checkmark" size={20} color="#007AFF" />
                            )}
                          </Pressable>
                        );
                      })
                    : // Level 1: sports. Single-team sports select directly;
                      // multi-team sports drill into their level teams.
                      pickerSports.map(sport => {
                        const logo = sport.isSingle
                          ? myTeams.find(t => t.id === sport.teams[0]?.id)?.logo
                          : undefined;
                        const selected =
                          sport.isSingle && storedCurrentTeamId === sport.teams[0]?.id;
                        return (
                          <Pressable
                            key={sport.key}
                            style={[
                              styles.pickerItem,
                              { borderBottomColor: Colors[colorScheme].border },
                              selected && { backgroundColor: Colors[colorScheme].surface },
                            ]}
                            onPress={() =>
                              sport.isSingle
                                ? selectPickerTeam(sport.teams[0].id, sport.teams[0].name)
                                : setPickerSportKey(sport.key)
                            }
                          >
                            <View style={styles.pickerItemContent}>
                              <View style={styles.teamLogoContainer}>
                                {logo ? (
                                  <Image
                                    source={{ uri: optimizeImageUrl(logo, 160) }}
                                    style={styles.teamLogoImage}
                                  />
                                ) : (
                                  <Text style={styles.teamLogoText}>🏆</Text>
                                )}
                              </View>
                              <Text
                                style={[styles.pickerItemText, { color: Colors[colorScheme].text }]}
                              >
                                {sport.label}
                                {sport.isSingle ? '' : `  (${sport.teams.length})`}
                              </Text>
                            </View>
                            {sport.isSingle ? (
                              selected && <Ionicons name="checkmark" size={20} color="#007AFF" />
                            ) : (
                              <Ionicons
                                name="chevron-forward"
                                size={20}
                                color={Colors[colorScheme].mutedText}
                              />
                            )}
                          </Pressable>
                        );
                      })}
                </ScrollView>
              </View>
            </View>
          </Modal>

          {/* Opponent Team Picker Modal */}
          <Modal
            visible={showOpponentPicker}
            transparent
            animationType="slide"
            onRequestClose={() => {
              setShowOpponentPicker(false);
              setOpponentSearchText('');
              setOpponentSearchResults([]);
              if (opponentSearchTimerRef.current) clearTimeout(opponentSearchTimerRef.current);
            }}
          >
            <KeyboardAvoidingView
              style={styles.pickerOverlay}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View
                style={[
                  styles.pickerContainer,
                  { backgroundColor: Colors[colorScheme].background },
                ]}
              >
                <View style={styles.pickerHeader}>
                  <Pressable
                    onPress={() => {
                      setShowOpponentPicker(false);
                      setOpponentSearchText('');
                      setOpponentSearchResults([]);
                      if (opponentSearchTimerRef.current)
                        clearTimeout(opponentSearchTimerRef.current);
                    }}
                  >
                    <Text style={[styles.pickerHeaderButton, { color: Colors[colorScheme].text }]}>
                      Cancel
                    </Text>
                  </Pressable>
                  <Text style={[styles.pickerTitle, { color: Colors[colorScheme].text }]}>
                    Select Opponent
                  </Text>
                  <View style={{ width: 50 }} />
                </View>

                {/* Search Bar */}
                <View
                  style={[
                    styles.searchContainer,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                >
                  <Ionicons name="search-outline" size={20} color={Colors[colorScheme].mutedText} />
                  <TextInput
                    style={[styles.searchInput, { color: Colors[colorScheme].text }]}
                    placeholder="Search VarsityHub teams..."
                    placeholderTextColor={Colors[colorScheme].mutedText}
                    value={opponentSearchText}
                    onChangeText={handleOpponentSearchChange}
                    autoCapitalize="words"
                    autoFocus
                  />
                  {opponentSearchLoading ? (
                    <ActivityIndicator size="small" color={Colors[colorScheme].mutedText} />
                  ) : opponentSearchText.length > 0 ? (
                    <Pressable
                      onPress={() => {
                        setOpponentSearchText('');
                        setOpponentSearchResults([]);
                        if (opponentSearchTimerRef.current)
                          clearTimeout(opponentSearchTimerRef.current);
                      }}
                    >
                      <Ionicons
                        name="close-circle"
                        size={20}
                        color={Colors[colorScheme].mutedText}
                      />
                    </Pressable>
                  ) : null}
                </View>

                <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
                  {/* Existing VarsityHub team results */}
                  {displayedOpponentTeams.map(team => (
                    <Pressable
                      key={team.id}
                      style={[
                        styles.pickerItem,
                        { borderBottomColor: Colors[colorScheme].border },
                        opponent === team.name && { backgroundColor: Colors[colorScheme].surface },
                      ]}
                      onPress={() => {
                        setOpponent(team.name);
                        setOpponentTeamId(team.id);
                        if (errors.opponent) setErrors(prev => ({ ...prev, opponent: '' }));
                        setOpponentSearchText('');
                        setOpponentSearchResults([]);
                        setShowOpponentPicker(false);
                      }}
                    >
                      <View style={styles.pickerItemContent}>
                        <View style={styles.teamLogoContainer}>
                          {team.logo ? (
                            <Image
                              source={{ uri: optimizeImageUrl(team.logo, 160) }}
                              style={styles.teamLogoImage}
                            />
                          ) : (
                            <Text style={styles.teamLogoText}>🏆</Text>
                          )}
                        </View>
                        <Text style={[styles.pickerItemText, { color: Colors[colorScheme].text }]}>
                          {team.name}
                        </Text>
                      </View>
                      {opponent === team.name && (
                        <Ionicons name="checkmark" size={20} color="#007AFF" />
                      )}
                    </Pressable>
                  ))}

                  {/* No results message */}
                  {opponentSearchText.trim().length > 0 &&
                    !opponentSearchLoading &&
                    displayedOpponentTeams.length === 0 && (
                      <View style={styles.noResultsContainer}>
                        <Text
                          style={[styles.noResultsText, { color: Colors[colorScheme].mutedText }]}
                        >
                          No VarsityHub teams found for "{opponentSearchText}"
                        </Text>
                      </View>
                    )}

                  {/* Manual entry — ALWAYS visible when text is present, even during loading */}
                  {opponentSearchText.trim().length > 0 && (
                    <Pressable
                      style={[
                        styles.pickerItem,
                        {
                          borderBottomColor: Colors[colorScheme].border,
                          backgroundColor: Colors[colorScheme].surface,
                        },
                      ]}
                      onPress={() => {
                        const name = opponentSearchText.trim();
                        setOpponent(name);
                        setOpponentTeamId(''); // No team ID — manual entry
                        if (errors.opponent) setErrors(prev => ({ ...prev, opponent: '' }));
                        setOpponentSearchText('');
                        setOpponentSearchResults([]);
                        if (opponentSearchTimerRef.current)
                          clearTimeout(opponentSearchTimerRef.current);
                        setOpponentSearchLoading(false);
                        setShowOpponentPicker(false);
                      }}
                    >
                      <View style={styles.pickerItemContent}>
                        <View style={styles.teamLogoContainer}>
                          <Ionicons
                            name="add-circle-outline"
                            size={24}
                            color={Colors[colorScheme].tint}
                          />
                        </View>
                        <Text
                          style={[
                            styles.pickerItemText,
                            { color: Colors[colorScheme].tint, fontWeight: '600' },
                          ]}
                        >
                          Use "{opponentSearchText.trim()}" as opponent
                        </Text>
                      </View>
                    </Pressable>
                  )}
                </ScrollView>
              </View>
            </KeyboardAvoidingView>
          </Modal>
        </View>
      </Modal>

      <ImageEditor
        visible={editorVisible}
        imageUri={editingImageUri}
        onClose={() => setEditorVisible(false)}
        onSave={async uri => {
          // upload edited image and set as bannerUrl
          setEditorVisible(false);
          setUploadingBanner(true);
          try {
            const uploaded = await uploadFile(
              getApiBaseUrl(),
              uri,
              'edited-banner.png',
              'image/png'
            );
            const url = uploaded?.url || uploaded?.path || null;
            if (url) setBannerUrl(url);
          } catch (e) {
            if (__DEV__) console.warn('Upload edited image failed', e);
          } finally {
            setUploadingBanner(false);
          }
        }}
      />
    </>
  );
}
