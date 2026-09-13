import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Memory-pressure guards for the full-screen vertical viewer.
 *
 * Regression context: every mounted card handed its media_url to
 * useVideoPlayer — including IMAGE posts — so a feed of photos allocated one
 * AVPlayer per card, and the FlatList default window kept ~21 full-screen
 * cards alive. The resulting iOS memory warnings purged expo-image caches and
 * blanked images app-wide (white profile grids/avatars after tapping through
 * a profile).
 */

const viewerSource = readFileSync(
  join(process.cwd(), 'app', 'game-details', 'GameVerticalFeedScreen.tsx'),
  'utf8'
);

const profileSource = readFileSync(join(process.cwd(), 'app', 'profile.tsx'), 'utf8');

describe('GameVerticalFeedScreen memory guards', () => {
  it('only gives the video player a source for actual videos', () => {
    expect(viewerSource).toContain("post.media_type === 'video' && post.media_url");
    expect(viewerSource).toContain('? { uri: optimizeVideoUrl(post.media_url) || post.media_url }');
    // The old unconditional form must not come back.
    expect(viewerSource).not.toContain('(post.media_url ? { uri: post.media_url } : null),');
  });

  it('bounds the vertical feed FlatList render window', () => {
    expect(viewerSource).toContain('windowSize={5}');
    expect(viewerSource).toContain('maxToRenderPerBatch={2}');
    expect(viewerSource).toContain('removeClippedSubviews');
  });
});

describe('profile grid thumbnails', () => {
  it('requests downsized Cloudinary transforms, not original uploads', () => {
    const optimized = profileSource.match(
      /optimizeImageUrl\(media\.previewUrl \|\| media\.displayImageUrl!, 500\)/g
    );
    // 8ad2939e consolidated all three tabs onto one shared tile renderer.
    expect(optimized?.length).toBe(1);
    expect(profileSource).toContain('const renderPostGridTile = useCallback');
    expect(profileSource.match(/renderPostGridList\(\{/g)?.length).toBe(3);
    expect(profileSource).not.toContain('source={{ uri: media.displayImageUrl! }}');
  });
});
