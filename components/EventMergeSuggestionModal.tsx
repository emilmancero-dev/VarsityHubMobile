import { toUserMessage } from '@/utils/toUserMessage';
/**
 * Event Merge Suggestion Modal
 *
 * Displays merge suggestions when duplicate events are detected
 * Allows coaches to merge or dismiss duplicate game events
 */

import CustomActionModal from '@/components/CustomActionModal';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { format } from 'date-fns';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

interface EventLocation {
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
}

interface MergeableEvent {
  id: string;
  title?: string;
  date?: string;
  location?: EventLocation;
  team_id?: string;
  opponent_team_id?: string;
  cover_image_url?: string;
}

interface MergeSuggestion {
  primaryEvent: MergeableEvent;
  duplicateEvent: MergeableEvent;
  matchScore: number;
  reasons: string[];
}

interface EventMergeSuggestionModalProps {
  visible: boolean;
  suggestion: MergeSuggestion | null;
  onMerge: (primaryEventId: string, duplicateEventId: string) => Promise<void>;
  onDismiss: () => void;
  loading?: boolean;
}

function EventSummaryCard({
  event,
  label,
  labelColor,
  backgroundColor,
  mutedTextColor,
  textColor,
  formatEventDate,
  formatLocation,
}: {
  event: MergeableEvent;
  label: string;
  labelColor: string;
  backgroundColor: string;
  mutedTextColor: string;
  textColor: string;
  formatEventDate: (date?: string) => string;
  formatLocation: (location?: EventLocation) => string;
}) {
  return (
    <View style={[styles.eventCard, { backgroundColor }]}>
      <Text style={[styles.eventLabel, { color: labelColor }]}>{label}</Text>
      <Text style={[styles.eventTitle, { color: textColor }]}>
        {event.title || 'Untitled Event'}
      </Text>
      <View style={styles.eventDetail}>
        <MaterialIcons name="access-time" size={14} color={mutedTextColor} />
        <Text style={[styles.eventDetailText, { color: mutedTextColor }]}>
          {formatEventDate(event.date)}
        </Text>
      </View>
      <View style={styles.eventDetail}>
        <MaterialIcons name="location-on" size={14} color={mutedTextColor} />
        <Text style={[styles.eventDetailText, { color: mutedTextColor }]}>
          {formatLocation(event.location)}
        </Text>
      </View>
    </View>
  );
}

export function EventMergeSuggestionModal({
  visible,
  suggestion,
  onMerge,
  onDismiss,
  loading = false,
}: EventMergeSuggestionModalProps) {
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [merging, setMerging] = useState(false);
  const [actionModal, setActionModal] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    options: Array<{ label: string; onPress: () => void; color?: string }>;
  } | null>(null);

  if (!suggestion) return null;

  const { primaryEvent, duplicateEvent, matchScore, reasons } = suggestion;

  const formatEventDate = (date?: string) => {
    if (!date) return 'TBD';
    try {
      return format(new Date(date), 'EEE, MMM d · h:mm a');
    } catch {
      return date;
    }
  };

  const formatLocation = (location?: EventLocation) => {
    if (location?.address) return location.address;
    if (location?.latitude && location?.longitude) {
      return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    }
    return 'Location TBD';
  };

  const handleMerge = async () => {
    setMerging(true);
    try {
      await onMerge(primaryEvent.id, duplicateEvent.id);
      setActionModal({
        visible: true,
        title: 'Events Merged',
        message: 'The duplicate events have been successfully merged into a single game.',
        options: [
          {
            label: 'OK',
            onPress: () => {
              setActionModal(null);
              onDismiss();
            },
            color: '#2563EB',
          },
        ],
      });
    } catch (error: any) {
      if (__DEV__) console.error('Failed to merge events:', error);
      setActionModal({
        visible: true,
        title: 'Merge Failed',
        message: toUserMessage(error, 'Unable to merge events. Please try again.'),
        options: [
          {
            label: 'OK',
            onPress: () => setActionModal(null),
            color: '#DC2626',
          },
        ],
      });
    } finally {
      setMerging(false);
    }
  };

  const handleDismiss = () => {
    setActionModal({
      visible: true,
      title: 'Keep Both Events?',
      message: 'Are you sure these are not duplicates? Both events will remain separate.',
      options: [
        {
          label: 'Cancel',
          onPress: () => setActionModal(null),
          color: theme.mutedText,
        },
        {
          label: 'Keep Separate',
          onPress: () => {
            setActionModal(null);
            onDismiss();
          },
          color: '#2563EB',
        },
      ],
    });
  };

  return (
    <>
      <CustomActionModal
        visible={visible}
        title="Duplicate Event Detected"
        onClose={onDismiss}
        options={[
          {
            label: 'Keep Separate',
            onPress: handleDismiss,
            color: theme.mutedText,
          },
          {
            label: merging ? 'Merging...' : 'Merge Events',
            onPress: merging ? () => {} : handleMerge,
            color: '#2563EB',
          },
        ]}
      >
        <ScrollView style={styles.content}>
          {/* Match Score */}
          <View style={styles.scoreContainer}>
            <MaterialIcons name="merge" size={24} color="#2563EB" />
            <Text style={[styles.scoreText, { color: Colors[colorScheme].text }]}>
              {matchScore}% Match
            </Text>
          </View>

          {/* Reasons */}
          <View style={styles.reasonsContainer}>
            <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
              Why we think these are duplicates:
            </Text>
            {reasons.map((reason, index) => (
              <View key={index} style={styles.reasonRow}>
                <MaterialIcons name="check-circle" size={16} color="#10B981" />
                <Text style={[styles.reasonText, { color: Colors[colorScheme].text }]}>
                  {reason}
                </Text>
              </View>
            ))}
          </View>

          {/* Event Comparison */}
          <View style={styles.comparisonContainer}>
            <EventSummaryCard
              event={primaryEvent}
              label="Event 1"
              labelColor="#2563EB"
              backgroundColor={Colors[colorScheme].background}
              mutedTextColor={theme.mutedText}
              textColor={Colors[colorScheme].text}
              formatEventDate={formatEventDate}
              formatLocation={formatLocation}
            />

            {/* Merge Icon */}
            <View style={styles.mergeIconContainer}>
              <MaterialIcons name="arrow-downward" size={24} color={theme.mutedText} />
            </View>

            <EventSummaryCard
              event={duplicateEvent}
              label="Event 2 (Duplicate)"
              labelColor="#DC2626"
              backgroundColor={Colors[colorScheme].background}
              mutedTextColor={theme.mutedText}
              textColor={Colors[colorScheme].text}
              formatEventDate={formatEventDate}
              formatLocation={formatLocation}
            />
          </View>

          {/* Explanation */}
          <View style={styles.explanationContainer}>
            <Text style={[styles.explanationText, { color: Colors[colorScheme].text }]}>
              Merging will combine both events into a single game. All RSVPs, posts, and content
              from both events will be preserved.
            </Text>
          </View>

          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="#2563EB" />
            </View>
          )}
        </ScrollView>
      </CustomActionModal>

      {/* Confirmation modals */}
      {actionModal && (
        <CustomActionModal
          visible={actionModal.visible}
          title={actionModal.title}
          message={actionModal.message}
          options={actionModal.options}
          onClose={() => setActionModal(null)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    maxHeight: 500,
  },
  scoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  scoreText: {
    fontSize: 18,
    fontWeight: '700',
  },
  reasonsContainer: {
    marginTop: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  reasonText: {
    fontSize: 14,
    flex: 1,
  },
  comparisonContainer: {
    marginTop: 8,
  },
  eventCard: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginBottom: 8,
  },
  eventLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  eventDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  eventDetailText: {
    fontSize: 13,
  },
  mergeIconContainer: {
    alignItems: 'center',
    marginVertical: 4,
  },
  explanationContainer: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
  },
  explanationText: {
    fontSize: 13,
    lineHeight: 18,
  },
  loadingContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});
