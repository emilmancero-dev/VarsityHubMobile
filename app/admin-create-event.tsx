import { toUserMessage } from '@/utils/toUserMessage';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import EventPreviewImageField from '@/components/EventPreviewImageField';
import { EventFormHeader, LocationSuggestionList } from '@/components/EventFormShared';
// @ts-ignore
import { httpPost } from '@/api/http';
import { Team } from '@/api/entities';
import { autocompleteLocations, PlaceSuggestion } from '@/api/geocoding';
import { safeGoBack } from '@/utils/navigation';
import { sanitizeText } from '@/utils/formUtils';
import DateTimePicker from '@react-native-community/datetimepicker';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';

const EVENT_TYPES = [
  { value: 'game', label: 'Game/Match', emoji: '🏈' },
  { value: 'watch_party', label: 'Watch Party', emoji: '📺' },
  { value: 'fundraiser', label: 'Fundraiser', emoji: '💰' },
  { value: 'tryout', label: 'Tryout/Practice', emoji: '🏃' },
  { value: 'bbq', label: 'BBQ/Social', emoji: '🍔' },
  { value: 'team_meal', label: 'Team Meal', emoji: '🍽️' },
  { value: 'other', label: 'Other', emoji: '📌' },
];

type TeamResult = { id: string; name: string; sport?: string; logo_url?: string | null };

function CreateEventScreen() {
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState<string>('game');
  const [location, setLocation] = useState('');
  const [locationSuggestions, setLocationSuggestions] = useState<PlaceSuggestion[]>([]);
  const [locationQuerying, setLocationQuerying] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSuggestion | null>(null);
  const locationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  // Team selection state (for competitive games)
  const [homeTeam, setHomeTeam] = useState<TeamResult | null>(null);
  const [awayTeam, setAwayTeam] = useState<TeamResult | null>(null);
  const [awayTeamName, setAwayTeamName] = useState('');
  const [homeSearch, setHomeSearch] = useState('');
  const [awaySearch, setAwaySearch] = useState('');
  const [homeResults, setHomeResults] = useState<TeamResult[]>([]);
  const [awayResults, setAwayResults] = useState<TeamResult[]>([]);
  const [searchingHome, setSearchingHome] = useState(false);
  const [searchingAway, setSearchingAway] = useState(false);
  const homeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isGameType = eventType === 'game';

  const searchTeams = useCallback((query: string, side: 'home' | 'away') => {
    const setSearching = side === 'home' ? setSearchingHome : setSearchingAway;
    const setResults = side === 'home' ? setHomeResults : setAwayResults;
    const timerRef = side === 'home' ? homeTimerRef : awayTimerRef;

    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await Team.list(query, false, { limit: 8 });
        setResults(res.teams || res.data || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, []);

  const handleLocationChange = useCallback((text: string) => {
    setLocation(text);
    setSelectedPlace(null);
    setErrors(prev => ({ ...prev, location: '' }));
    if (locationTimerRef.current) clearTimeout(locationTimerRef.current);
    if (text.length < 3) {
      setLocationSuggestions([]);
      setLocationQuerying(false);
      return;
    }
    setLocationQuerying(true);
    locationTimerRef.current = setTimeout(async () => {
      try {
        const suggestions = await autocompleteLocations(text, 6);
        setLocationSuggestions(suggestions);
      } catch {
        setLocationSuggestions([]);
      } finally {
        setLocationQuerying(false);
      }
    }, 300);
  }, []);

  const handleSelectLocation = useCallback((suggestion: PlaceSuggestion) => {
    setLocation(suggestion.description);
    setSelectedPlace(suggestion);
    setLocationSuggestions([]);
    setLocationQuerying(false);
    setErrors(prev => ({ ...prev, location: '' }));
  }, []);

  useEffect(() => {
    const locationTimer = locationTimerRef.current;
    const homeTimer = homeTimerRef.current;
    const awayTimer = awayTimerRef.current;
    return () => {
      if (locationTimer) clearTimeout(locationTimer);
      if (homeTimer) clearTimeout(homeTimer);
      if (awayTimer) clearTimeout(awayTimer);
    };
  }, []);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};
    if (!title.trim()) newErrors.title = 'Title is required';
    if (!location.trim()) newErrors.location = 'Location is required';
    // Teams are optional — admin can create standalone platform events without teams
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    setSubmitting(true);
    try {
      // All admin events go through /games so they get a full event page
      // with stories, polls, RSVP, and appear as cards in the feed
      const gameData: Record<string, any> = {
        title: sanitizeText(title),
        description: sanitizeText(description),
        event_type: eventType,
        location: selectedPlace?.description || location,
        venue_address: selectedPlace?.description || location,
        venue_place_id: selectedPlace?.place_id,
        date: date.toISOString(),
        autoGeocode: !selectedPlace,
      };

      if (previewImageUrl) {
        gameData.banner_url = previewImageUrl;
        gameData.cover_image_url = previewImageUrl;
      }

      // Add team info only if provided
      if (homeTeam) {
        gameData.home_team_id = homeTeam.id;
        gameData.home_team = homeTeam.name;
      }
      if (awayTeam) {
        gameData.away_team_id = awayTeam.id;
        gameData.away_team = awayTeam.name;
      }
      if (!awayTeam && awayTeamName.trim()) {
        gameData.away_team_name = awayTeamName.trim();
        gameData.away_team = awayTeamName.trim();
      }

      await httpPost('/games', gameData);

      Alert.alert('Event Created!', 'Your event has been published and is visible to all users.', [
        {
          text: 'OK',
          onPress: () => {
            safeGoBack(router);
          },
        },
      ]);
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      const errorMsg = toUserMessage(
        e,
        'Failed to create event. Please check your entries and try again.'
      );
      Alert.alert('Error', errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  if (adminLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
        edges={['bottom']}
      >
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors[colorScheme].tint} />
      </SafeAreaView>
    );
  }
  if (!isAdmin) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
        edges={['bottom']}
      >
        <Text style={{ textAlign: 'center', marginTop: 40, color: Colors[colorScheme].text }}>
          Admin access required
        </Text>
      </SafeAreaView>
    );
  }

  const renderTeamPicker = (
    side: 'home' | 'away',
    selectedTeam: TeamResult | null,
    searchQuery: string,
    results: TeamResult[],
    searching: boolean
  ) => {
    const label = side === 'home' ? 'Home Team' : 'Away Team';
    const errorKey = side === 'home' ? 'homeTeam' : 'awayTeam';
    const setSearch = side === 'home' ? setHomeSearch : setAwaySearch;
    const setSelected = side === 'home' ? setHomeTeam : setAwayTeam;
    const setResults = side === 'home' ? setHomeResults : setAwayResults;

    if (selectedTeam) {
      return (
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>{label} *</Text>
          <View
            style={[
              styles.selectedTeam,
              { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].tint },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.selectedTeamName, { color: Colors[colorScheme].text }]}>
                {selectedTeam.name}
              </Text>
              {selectedTeam.sport && (
                <Text style={{ fontSize: 13, color: Colors[colorScheme].mutedText }}>
                  {selectedTeam.sport}
                </Text>
              )}
            </View>
            <Pressable
              onPress={() => {
                setSelected(null);
                setSearch('');
                setResults([]);
              }}
            >
              <MaterialIcons name="close" size={20} color={Colors[colorScheme].mutedText} />
            </Pressable>
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.section, { zIndex: side === 'home' ? 9 : 8 }]}>
        <Text style={[styles.label, { color: Colors[colorScheme].text }]}>{label} *</Text>
        <View style={{ position: 'relative' }}>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: Colors[colorScheme].card,
                borderColor: errors[errorKey] ? '#EF4444' : Colors[colorScheme].border,
                color: Colors[colorScheme].text,
              },
            ]}
            value={searchQuery}
            onChangeText={text => {
              setSearch(text);
              searchTeams(text, side);
            }}
            placeholder={`Search for ${side} team...`}
            placeholderTextColor={Colors[colorScheme].mutedText}
            autoCapitalize="words"
            autoCorrect={false}
          />
          {searching && (
            <ActivityIndicator
              size="small"
              color={Colors[colorScheme].tint}
              style={{ position: 'absolute', right: 12, top: 12 }}
            />
          )}
          {results.length > 0 && (
            <View
              style={[
                styles.suggestionList,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              {results.map((team, index) => (
                <Pressable
                  key={team.id}
                  style={[
                    styles.suggestionItem,
                    { borderBottomColor: Colors[colorScheme].border },
                    index === results.length - 1 && { borderBottomWidth: 0 },
                  ]}
                  onPress={() => {
                    setSelected(team);
                    setSearch('');
                    setResults([]);
                    setErrors(prev => ({ ...prev, [errorKey]: '' }));
                  }}
                >
                  <MaterialIcons
                    name="groups"
                    size={16}
                    color={Colors[colorScheme].tint}
                    style={{ marginRight: 8 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ fontSize: 15, fontWeight: '500', color: Colors[colorScheme].text }}
                    >
                      {team.name}
                    </Text>
                    {team.sport && (
                      <Text
                        style={{ fontSize: 13, color: Colors[colorScheme].mutedText, marginTop: 1 }}
                      >
                        {team.sport}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
        {errors[errorKey] && <Text style={styles.errorText}>{errors[errorKey]}</Text>}
        {side === 'away' && !awayTeam && (
          <View style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 12, color: Colors[colorScheme].mutedText, marginBottom: 4 }}>
              Or type opponent name manually:
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              value={awayTeamName}
              onChangeText={text => {
                setAwayTeamName(text);
                setErrors(prev => ({ ...prev, awayTeam: '' }));
              }}
              placeholder="e.g., Lincoln High School"
              placeholderTextColor={Colors[colorScheme].mutedText}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ title: 'Create Official Event' }} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <EventFormHeader
          title="Create Official Event"
          subtitle="As an administrator, this event will be automatically approved and published."
          textColor={Colors[colorScheme].text}
          mutedTextColor={Colors[colorScheme].mutedText}
        />

        {/* Event Type */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Event Type *</Text>
          <View style={styles.typeGrid}>
            {EVENT_TYPES.map(type => (
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
                ]}
                onPress={() => setEventType(type.value)}
              >
                <Text style={{ fontSize: 24 }}>{type.emoji}</Text>
                <Text
                  style={[
                    styles.typeLabel,
                    {
                      color:
                        eventType === type.value
                          ? Colors[colorScheme].tint
                          : Colors[colorScheme].mutedText,
                    },
                  ]}
                >
                  {type.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Team pickers for competitive games */}
        {isGameType && (
          <>
            {renderTeamPicker('home', homeTeam, homeSearch, homeResults, searchingHome)}
            {renderTeamPicker('away', awayTeam, awaySearch, awayResults, searchingAway)}
          </>
        )}

        {/* Title */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Title *</Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: Colors[colorScheme].card,
                borderColor: errors.title ? '#EF4444' : Colors[colorScheme].border,
                color: Colors[colorScheme].text,
              },
            ]}
            value={title}
            onChangeText={setTitle}
            placeholder={isGameType ? 'e.g., Varsity Championship Game' : 'e.g., Team BBQ Night'}
            placeholderTextColor={Colors[colorScheme].mutedText}
          />
          {errors.title && <Text style={styles.errorText}>{errors.title}</Text>}
        </View>

        {/* Description */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Description</Text>
          <TextInput
            style={[
              styles.input,
              styles.textArea,
              {
                backgroundColor: Colors[colorScheme].card,
                borderColor: Colors[colorScheme].border,
                color: Colors[colorScheme].text,
              },
            ]}
            value={description}
            onChangeText={setDescription}
            placeholder="Add details about the event..."
            placeholderTextColor={Colors[colorScheme].mutedText}
            multiline
          />
        </View>

        <EventPreviewImageField
          value={previewImageUrl}
          onChange={setPreviewImageUrl}
          disabled={submitting}
          helperText="Upload the event preview image that should appear on the feed card and event page."
        />

        {/* Location */}
        <View style={[styles.section, { zIndex: 10 }]}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Location *</Text>
          <View style={{ position: 'relative' }}>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: errors.location ? '#EF4444' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              value={location}
              onChangeText={handleLocationChange}
              placeholder="Start typing an address or venue"
              placeholderTextColor={Colors[colorScheme].mutedText}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <LocationSuggestionList
              suggestions={locationSuggestions}
              querying={locationQuerying}
              onSelect={handleSelectLocation}
              tintColor={Colors[colorScheme].tint}
              textColor={Colors[colorScheme].text}
              mutedTextColor={Colors[colorScheme].mutedText}
              cardColor={Colors[colorScheme].card}
              borderColor={Colors[colorScheme].border}
            />
          </View>
          {errors.location && <Text style={styles.errorText}>{errors.location}</Text>}
        </View>

        {/* Date & Time */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Date & Time *</Text>
          <View style={styles.dateContainer}>
            <Pressable onPress={() => setShowDatePicker(true)} style={styles.dateDisplay}>
              <Text style={{ color: Colors[colorScheme].text }}>{date.toLocaleDateString()}</Text>
            </Pressable>
            <Pressable onPress={() => setShowTimePicker(true)} style={styles.dateDisplay}>
              <Text style={{ color: Colors[colorScheme].text }}>{date.toLocaleTimeString()}</Text>
            </Pressable>
          </View>
          {showDatePicker && (
            <DateTimePicker
              value={date}
              mode="date"
              display="default"
              onChange={(event, selectedDate) => {
                setShowDatePicker(false);
                if (selectedDate) setDate(selectedDate);
              }}
            />
          )}
          {showTimePicker && (
            <DateTimePicker
              value={date}
              mode="time"
              display="default"
              onChange={(event, selectedDate) => {
                setShowTimePicker(false);
                if (selectedDate) setDate(selectedDate);
              }}
            />
          )}
        </View>
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: Colors[colorScheme].border }]}>
        <Pressable
          style={[styles.submitButton, { backgroundColor: Colors[colorScheme].tint }]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.submitButtonText}>
              {isGameType ? 'Create Game' : 'Create Event'}
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 12,
    marginTop: 4,
  },
  dateContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  dateDisplay: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  typeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  typeLabel: {
    marginLeft: 8,
    fontSize: 14,
    fontWeight: '500',
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
  },
  submitButton: {
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  submitButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  suggestionList: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: 200,
    zIndex: 1000,
    elevation: 5,
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
  },
  selectedTeam: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  selectedTeamName: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default CreateEventScreen;
