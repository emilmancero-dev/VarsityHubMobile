import { Post } from '@/api/entities';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { resolveMediaType } from '@/utils/media';
import { prefetchUserProfile } from '@/utils/prefetch';
import { REPORT_REASONS, usePostInteractions } from '@/hooks/usePostInteractions';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import EventChip from './EventChip';
import ExpandableText from './ExpandableText';
import PollCard from './PollCard';

type MasonryPostCardProps = {
  post: any;
  onPress?: () => void;
  onDeleted?: (postId: string) => void;
  onUpdated?: (updatedPost: any) => void;
};

function MasonryPostCard({
  post,
  onPress,
  onDeleted: _onDeleted,
  onUpdated: _onUpdated,
}: MasonryPostCardProps) {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const { upvotesCount, bookmarked, onUpvote, onBookmark, submitReport } = usePostInteractions({
    postId: String(post.id),
    initialUpvotes: post.upvotes_count || 0,
    initialBookmarked: !!post.has_bookmarked,
    tag: 'MasonryPostCard',
  });
  const [pressed, setPressed] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const mediaUrl = post?.media_url || post?.mediaUrl || null;
  const previewUrl = post?.preview_url || post?.thumbnail_url || post?.previewUrl || null;
  const resolvedMediaType = resolveMediaType(mediaUrl, post?.media_type);
  const isImage = resolvedMediaType === 'image';
  const isVideo = resolvedMediaType === 'video';
  const caption = useMemo(() => post.caption || post.content || '', [post.caption, post.content]);
  const author = post?.author || null;
  const hasPoll = !!post.poll;

  // Calculate dynamic height based on content
  const mediaHeight = useMemo(() => {
    if (!mediaUrl) return 0;
    // Randomize heights for Pinterest-style masonry
    const heights = [180, 220, 260, 300, 340, 280, 240, 200];
    const hash = post.id
      ? String(post.id)
          .split('')
          .reduce((acc, char) => acc + char.charCodeAt(0), 0)
      : 0;
    return heights[hash % heights.length];
  }, [post.id, mediaUrl]);

  const handleVotePoll = async (_pollId: string, optionId: string) => {
    // voteOnPoll takes the POST id, not the poll id
    const result = await Post.voteOnPoll(post.id, optionId);
    analytics.track(ANALYTICS_EVENTS.POLL_VOTED, {
      post_id: post.id,
      option_id: optionId,
    });
    // Server now returns serialized poll with { options: [{ id, text, votes }], totalVotes }
    if (result?.options) {
      return { options: result.options, totalVotes: result.totalVotes || 0 };
    }
    return result;
  };

  const handleReport = () => {
    const reasons = REPORT_REASONS.slice(0, 5); // Show top reasons in action sheet
    Alert.alert('Report Post', 'Select a reason:', [
      ...reasons.map(r => ({
        text: r.label,
        style: 'default' as const,
        onPress: () => {
          void submitReport(r.value);
        },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.container,
        {
          backgroundColor: Colors[colorScheme].card,
          borderColor: Colors[colorScheme].border,
        },
        pressed && styles.containerPressed,
      ]}
    >
      {/* Author Header */}
      {author ? (
        <View style={styles.authorRow}>
          <Pressable
            style={styles.authorInfo}
            onPressIn={() => prefetchUserProfile(author?.id ? String(author.id) : null)}
            onPress={() => {
              if (!author?.id) return;
              router.push({
                pathname: '/user-profile',
                params: { id: String(author.id), username: author.username || 'User' },
              });
            }}
          >
            <View style={styles.authorAvatarWrap}>
              {author?.avatar_url ? (
                <Image
                  source={{ uri: optimizeImageUrl(String(author.avatar_url), 80) }}
                  style={styles.authorAvatar}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={String(author?.id ?? author?.username ?? post.id)}
                />
              ) : (
                <LinearGradient colors={['#1E1E1E', '#121212']} style={styles.authorAvatar} />
              )}
            </View>
            <Text
              numberOfLines={1}
              style={[styles.authorName, { color: Colors[colorScheme].text }]}
            >
              {author?.username ? `@${author.username}` : 'User'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <EventChip
        gameId={(post as any)?.game_id ?? (post as any)?.game?.id}
        eventId={(post as any)?.event_id ?? (post as any)?.event?.id}
        variant="card"
        style={styles.eventChip}
      />

      {/* Media Section */}
      {(isImage || isVideo) && (
        <View style={[styles.mediaWrap, { height: mediaHeight }]}>
          {isImage && mediaUrl ? (
            <Image
              source={{ uri: optimizeImageUrl(mediaUrl, 600) }}
              style={styles.media}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={String(post.id)}
              transition={150}
            />
          ) : isVideo && previewUrl && !previewError ? (
            <Image
              source={{ uri: optimizeImageUrl(previewUrl, 600) }}
              style={styles.media}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={String(post.id)}
              onError={() => setPreviewError(true)}
            />
          ) : isVideo && mediaUrl ? (
            <View
              style={[
                styles.media,
                { backgroundColor: '#121212', alignItems: 'center', justifyContent: 'center' },
              ]}
            >
              <MaterialIcons name="videocam" size={28} color="#94a3b8" />
            </View>
          ) : null}
          {isVideo && (
            <View style={styles.playOverlay}>
              <MaterialIcons name="play-arrow" size={24} color="#fff" />
            </View>
          )}
        </View>
      )}

      {/* Poll Section */}
      {hasPoll && <PollCard poll={post.poll} onVote={handleVotePoll} />}

      {/* Caption - show under poll if poll exists, otherwise show normally */}
      <ExpandableText
        text={caption}
        maxLines={3}
        style={[styles.caption, { color: Colors[colorScheme].text }]}
        expandStyle={[styles.captionToggle, { color: Colors[colorScheme].tint }]}
      />

      {/* Footer Actions */}
      <View style={styles.footer}>
        <Pressable
          onPress={onUpvote}
          style={[styles.actionBtn, { backgroundColor: Colors[colorScheme].tint }]}
        >
          <MaterialIcons name="arrow-upward" size={14} color="#fff" />
          <Text style={styles.actionText}>{upvotesCount}</Text>
        </Pressable>

        <View style={styles.metaRow}>
          <MaterialIcons
            name="chat-bubble-outline"
            size={14}
            color={Colors[colorScheme].mutedText}
          />
          <Text style={[styles.metaText, { color: Colors[colorScheme].mutedText }]}>
            {post.comments_count || 0}
          </Text>
        </View>

        <View style={{ flex: 1 }} />

        <Pressable onPress={handleReport} style={styles.bookmarkBtn}>
          <MaterialIcons name="flag" size={14} color={Colors[colorScheme].mutedText} />
        </Pressable>

        <Pressable onPress={onBookmark} style={styles.bookmarkBtn}>
          <MaterialIcons
            name={bookmarked ? 'bookmark' : 'bookmark-outline'}
            size={16}
            color={Colors[colorScheme].text}
          />
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 10px rgba(15, 23, 42, 0.06)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.06,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 2,
    marginBottom: 2,
  },
  containerPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
  eventChip: {
    marginHorizontal: 10,
    marginBottom: 8,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  authorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  authorAvatarWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    overflow: 'hidden',
  },
  authorAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  authorName: {
    fontWeight: '600',
    fontSize: 13,
  },
  mediaWrap: {
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
    position: 'relative',
  },
  media: {
    width: '100%',
    height: '100%',
  },
  playOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 40,
    height: 40,
    marginLeft: -20,
    marginTop: -20,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
    marginBottom: 8,
  },
  captionToggle: {
    marginBottom: 8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  actionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  metaText: {
    fontWeight: '600',
    fontSize: 12,
  },
  bookmarkBtn: {
    padding: 4,
  },
});

export default React.memo(MasonryPostCard);
