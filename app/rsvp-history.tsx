import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Event as EventApi } from '@/api/entities';
import { buildEventDetailRoute } from '@/utils/eventRoutes';

type Item = {
  id: string;
  created_at?: string;
  event?: { id: string; title?: string; date?: string; location?: string };
};

function RsvpHistoryScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // react-query owns the fetch: cached RSVPs render instantly on revisit.
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['my-rsvps'],
    queryFn: () => EventApi.myRsvps() as Promise<Item[]>,
  });
  const items: Item[] = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const loading = isPending;
  const error = isError ? 'Failed to load watching history. Pull down to refresh.' : null;

  // Filter items by search query and date
  const filteredItems = useMemo(() => {
    let filtered = items;

    // Apply search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(item => {
        const title = (item.event?.title || '').toLowerCase();
        const location = (item.event?.location || '').toLowerCase();
        return title.includes(q) || location.includes(q);
      });
    }

    // Apply date filter
    if (selectedDate) {
      const startOfDay = new Date(selectedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(selectedDate);
      endOfDay.setHours(23, 59, 59, 999);

      filtered = filtered.filter(item => {
        if (!item.event?.date) return false;
        const eventDate = new Date(String(item.event.date));
        return eventDate >= startOfDay && eventDate <= endOfDay;
      });
    }

    return filtered;
  }, [items, searchQuery, selectedDate]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    return filteredItems.filter(
      i => i.event?.date && new Date(String(i.event.date)).getTime() >= now
    );
  }, [filteredItems]);

  const past = useMemo(() => {
    const now = Date.now();
    return filteredItems.filter(
      i => i.event?.date && new Date(String(i.event.date)).getTime() < now
    );
  }, [filteredItems]);

  const renderItem = ({ item }: { item: Item }) => (
    <Pressable
      style={[
        styles.card,
        { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
      ]}
      onPress={() =>
        item.event?.id &&
        router.push(buildEventDetailRoute(item.event.id, (item.event as any)?.game_id))
      }
    >
      <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
        {item.event?.title || 'Event'}
      </Text>
      <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
        {item.event?.location || 'TBD'}
      </Text>
      <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
        {item.event?.date ? new Date(String(item.event.date)).toLocaleString() : ''}
      </Text>
    </Pressable>
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{ title: '📺 Watching History', headerBackTitle: 'Back', headerShown: true }}
      />

      {/* Search and Filter Controls */}
      <View style={styles.filterSection}>
        <View
          style={[
            styles.searchContainer,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
        >
          <MaterialIcons name="search" size={20} color={Colors[colorScheme].mutedText} />
          <TextInput
            style={[styles.searchInput, { color: Colors[colorScheme].text }]}
            placeholder="Search events by title or location..."
            placeholderTextColor={Colors[colorScheme].mutedText}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')}>
              <MaterialIcons name="cancel" size={20} color={Colors[colorScheme].mutedText} />
            </Pressable>
          )}
        </View>

        <Pressable
          style={[
            styles.dateButton,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
          onPress={() => {
            if (selectedDate) {
              setSelectedDate(null); // Clear filter
            } else {
              setSelectedDate(new Date()); // Set to today
            }
          }}
        >
          <MaterialIcons
            name="event"
            size={20}
            color={selectedDate ? Colors[colorScheme].tint : Colors[colorScheme].mutedText}
          />
          <Text
            style={[
              styles.dateButtonText,
              { color: selectedDate ? Colors[colorScheme].tint : Colors[colorScheme].mutedText },
              selectedDate && styles.dateButtonTextActive,
            ]}
          >
            {selectedDate ? selectedDate.toLocaleDateString() : 'Filter by date'}
          </Text>
          {selectedDate && (
            <MaterialIcons name="cancel" size={16} color={Colors[colorScheme].tint} />
          )}
        </Pressable>
      </View>

      <Text style={[styles.header, { color: Colors[colorScheme].text }]}>Upcoming</Text>
      {loading && (
        <View style={{ paddingVertical: 10 }}>
          <ActivityIndicator color={Colors[colorScheme].tint} />
        </View>
      )}
      {error && !loading && (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#FCA5A5' : '#DC2626',
              fontSize: 16,
              textAlign: 'center',
              marginBottom: 16,
            }}
          >
            {error}
          </Text>
          <TouchableOpacity
            onPress={() => void refetch()}
            style={{
              backgroundColor: Colors[colorScheme].tint,
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 8,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      {!loading && upcoming.length === 0 && (
        <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
          Nothing marked as watching yet.
        </Text>
      )}
      {!loading && upcoming.length > 0 && (
        <FlatList
          data={upcoming}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        />
      )}
      <Text style={[styles.header, { marginTop: 6, color: Colors[colorScheme].text }]}>Past</Text>
      {!loading && past.length === 0 && (
        <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
          No past watched events.
        </Text>
      )}
      {!loading && past.length > 0 && (
        <FlatList
          data={past}
          keyExtractor={i => 'p-' + i.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  filterSection: { marginBottom: 8, gap: 10 },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 15 },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  dateButtonText: { flex: 1, fontSize: 14, fontWeight: '600' },
  dateButtonTextActive: { color: '#2563EB' },
  header: { fontSize: 18, fontWeight: '800', marginBottom: 4 },
  error: { color: '#b91c1c' },
  muted: {},
  card: { padding: 12, borderRadius: 12, borderWidth: 1 },
  title: { fontWeight: '700' },
});

export default RsvpHistoryScreen;
