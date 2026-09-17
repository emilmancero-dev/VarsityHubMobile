import { HAS_POSTS_COLOR } from '@/utils/mapMarkerColor';
import { formatEventCardTitle } from '@/utils/eventTitle';
import { getDeterministicGameCardGradient, proGameCardGradient } from '@/utils/feedGameCard';
import { getLiveBounds } from '@/utils/liveWindow';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { getVenuePhotoFallback } from '@/utils/venuePhotoFallback';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { format } from 'date-fns';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Image as RNImage, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

// A game/event page as it appears on a feed-style hero card. Deliberately loose
// so the same card renders feed items and the profile Events tab.
export type EventFeedCardItem = {
  id: string;
  title?: string | null;
  date?: string | null;
  location?: string | null;
  sport?: string | null;
  event_type?: string | null;
  pro_league?: string | null;
  cover_image_url?: string | null;
  banner_url?: string | null;
  source_type?: 'game' | 'event';
  venue_photo?: { url: string; credit: string } | null;
  pro_home_color?: string | null;
  pro_away_color?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  starts_at?: string | null;
  live_from?: string | null;
  live_until?: string | null;
  [key: string]: any;
};

function FullBleedCardImage({ uri }: { uri: string }) {
  if (Platform.OS === 'web') {
    return <RNImage source={{ uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />;
  }
  return <Image source={{ uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />;
}

export type EventFeedCardProps = {
  item: EventFeedCardItem;
  colorScheme: 'light' | 'dark';
  isLive?: boolean;
  hasPosts?: boolean;
  voteText?: string | null;
  /** Absolutely-positioned bottom-right slot (RSVP control or post counter). */
  badge?: ReactNode;
  titleLines?: number;
  testID?: string;
  onPress?: () => void;
  onPressIn?: () => void;
};

/**
 * The single-column hero card used for game/event pages on the feed and on the
 * profile Events tab. One implementation so the two surfaces stay identical
 * (owner rule: no duplicate cards). Presentational only — the caller supplies
 * the bottom-right badge (a live-interactive RSVP control on the feed, a static
 * post counter on a profile).
 */
export function EventFeedCard({
  item,
  colorScheme,
  isLive = false,
  hasPosts = false,
  voteText = null,
  badge,
  titleLines = 1,
  testID,
  onPress,
  onPressIn,
}: EventFeedCardProps) {
  const raw = item as any;
  const isEventOnly = item.source_type === 'event';
  const entityLabel = isEventOnly ? 'Event' : 'Game';

  const firstMediaUrl =
    Array.isArray(raw?.media) && raw.media.length > 0
      ? raw.media[0]?.thumbnail_url || raw.media[0]?.url || null
      : Array.isArray(raw?.posts) && raw.posts.length > 0
        ? raw.posts[0]?.media_url || raw.posts[0]?.thumbnail_url || null
        : null;
  const venuePhoto = raw?.venue_photo ?? getVenuePhotoFallback(item.location);
  const venuePhotoUrl = venuePhoto?.url || null;
  const banner = item.cover_image_url || raw?.banner_url || venuePhotoUrl || firstMediaUrl || null;
  const hasBanner = typeof banner === 'string' && banner.length > 0;

  const gradient =
    proGameCardGradient(raw?.pro_home_color, raw?.pro_away_color) ??
    getDeterministicGameCardGradient(item.id, item.title ?? '');

  const startsAtMs = getLiveBounds(item as any)?.startsAt;
  const displayStart =
    typeof startsAtMs === 'number' && !Number.isNaN(startsAtMs)
      ? new Date(startsAtMs)
      : item.date
        ? new Date(item.date)
        : null;
  const eventDate = displayStart ? format(displayStart, 'MMM d') : 'TBD';
  const eventTime = displayStart ? format(displayStart, 'h:mm a') : '';
  const locationText = item.location ? String(item.location).split(',')[0] : 'Location TBD';

  const reviewsCount =
    typeof raw?.reviews_count === 'number'
      ? raw.reviews_count
      : Array.isArray(raw?.reviews)
        ? raw.reviews.length
        : raw?._count && typeof raw._count.reviews === 'number'
          ? raw._count.reviews
          : 0;
  const mediaCount =
    typeof raw?.media_count === 'number'
      ? raw.media_count
      : Array.isArray(raw?.media)
        ? raw.media.length
        : 0;
  const scoreText =
    typeof raw?.home_score === 'number' && typeof raw?.away_score === 'number'
      ? `${raw.home_score} - ${raw.away_score}`
      : null;

  const title = formatEventCardTitle(item) || entityLabel;

  return (
    <Pressable
      testID={testID}
      style={[
        styles.card,
        isLive ? { borderWidth: 2, borderColor: hasPosts ? HAS_POSTS_COLOR : '#EF4444' } : null,
      ]}
      onPressIn={onPressIn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title} on ${eventDate}${eventTime ? ` at ${eventTime}` : ''}${isLive ? ' — LIVE NOW' : ''}`}
    >
      <LinearGradient
        colors={gradient}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      {hasBanner && <FullBleedCardImage uri={optimizeImageUrl(banner!, 400) || banner!} />}
      <LinearGradient
        colors={
          colorScheme === 'dark'
            ? ['rgba(15,23,42,0.1)', 'rgba(15,23,42,0.9)']
            : ['rgba(15,23,42,0.05)', 'rgba(15,23,42,0.85)']
        }
        style={[styles.shade, { pointerEvents: 'none' }]}
      />
      <View style={styles.content}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={styles.dateChip}>
            <MaterialIcons name="event" size={12} color="#FFFFFF" />
            <Text style={styles.dateText}>{eventDate}</Text>
          </View>
          {isLive ? (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={titleLines}>
          {title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {scoreText
            ? `${scoreText} • ${eventTime ? `${eventTime} • ${locationText}` : locationText}`
            : eventTime
              ? `${eventTime} • ${locationText}`
              : locationText}
        </Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <MaterialIcons name="chat-bubble-outline" size={12} color="#F9FAFB" />
            <Text style={styles.statText}>{reviewsCount}</Text>
          </View>
          <View style={styles.stat}>
            <MaterialIcons name="image" size={12} color="#F9FAFB" />
            <Text style={styles.statText}>{mediaCount}</Text>
          </View>
        </View>
        {voteText ? (
          <Text style={styles.voteText} numberOfLines={1}>
            {voteText}
          </Text>
        ) : null}
      </View>
      {badge}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    // Matches the event detail page's fixed banner height (GameDetailsScreen
    // bannerHeight) so the same photo isn't cropped differently here vs there.
    height: 240,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#121212',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(15, 23, 42, 0.12)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  shade: { ...StyleSheet.absoluteFillObject },
  content: { position: 'absolute', left: 12, right: 12, bottom: 12, gap: 6 },
  dateChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.65)',
  },
  dateText: { color: '#F9FAFB', fontWeight: '700', fontSize: 12 },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EF4444',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 4,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  title: { color: '#FFFFFF', fontWeight: '800', fontSize: 14, lineHeight: 18 },
  meta: { color: '#D1D5DB', fontSize: 12 },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { color: '#F9FAFB', fontSize: 11, fontWeight: '600' },
  voteText: { color: '#E0F2FE', fontSize: 11, fontWeight: '600' },
});
