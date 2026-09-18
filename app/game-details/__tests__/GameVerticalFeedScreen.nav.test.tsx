import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'app', 'game-details', 'GameVerticalFeedScreen.tsx'),
  'utf8'
);

// StyleSheet definitions were extracted to a co-located styles module (kept out
// of the app/ router tree). Style-invariant assertions read from there.
const styleSource = readFileSync(
  join(process.cwd(), 'styles', 'game-details', 'GameVerticalFeedScreen.styles.ts'),
  'utf8'
);

describe('GameVerticalFeedScreen rail actions', () => {
  it('removes the rail nav toggle and standalone share button', () => {
    expect(source).not.toContain('highlights-nav-up');
    expect(source).not.toContain('highlights-nav-down');
    expect(source).not.toContain('FeedRailNavButtons');
    expect(source).not.toContain('<Text style={styles.railLabel}>Share</Text>');
  });

  it('keeps the action rail focused on upvote, comments, bookmark, and options', () => {
    expect(source).toContain("name={post.has_upvoted ? 'arrow-up' : 'arrow-up-outline'}");
    expect(source).toContain('chatbubble-ellipses-outline');
    expect(source).toContain("name={post.has_bookmarked ? 'bookmark' : 'bookmark-outline'}");
    expect(source).toContain('<Text style={styles.railLabel}>Options</Text>');
  });

  it('keeps the avatar out of the action rail (2026-07-17: it covered the media)', () => {
    // The poster profile stays reachable via the @username in the caption
    // overlay, which shares the same onOpenAuthorProfile handler.
    expect(source).not.toContain('railAvatarWrap');
    expect(source).not.toContain('railAvatarBtn');
    expect(source).not.toContain('railAvatarImg');
    expect(source).toMatch(/onPress=\{post\.author\?\.id \? onOpenAuthorProfile : undefined\}/);
  });

  it('moves share into the combined options menu', () => {
    expect(source).toContain('Share Post');
    expect(source).toContain('Copy Link');
    expect(source).toContain('Report Post');
    expect(source).toMatch(/setShowOptionsMenu\(false\);\s*onSharePost\(\);/);
  });

  it('falls back to copying the link when native post sharing fails', () => {
    expect(source).toContain("console.warn('[GameVerticalFeed] Link share failed");
    expect(source).toContain("await import('expo-clipboard')");
    expect(source).toContain(
      "Alert.alert('Share unavailable', 'Link copied to clipboard so you can paste it manually.');"
    );
    expect(source).not.toMatch(
      /Share\.share\(buildNativeSharePayload[\s\S]*\.catch\(\(\) => \{\}\)/
    );
  });

  it('keeps interactive overlays above the full-screen media press target', () => {
    expect(styleSource).toMatch(/captionOverlay:\s*\{[\s\S]*zIndex:\s*20/);
    expect(styleSource).toMatch(/rail:\s*\{[\s\S]*zIndex:\s*20/);
    expect(styleSource).toMatch(/titleOverlay:\s*\{[\s\S]*zIndex:\s*30/);
    expect(source).toContain("pointerEvents: 'box-none'");
  });

  it('closes modal-backed viewers before pushing a new route', () => {
    expect(source).toContain('const navigateFromViewer = useCallback(');
    expect(source).toContain('if (onClose) {');
    expect(source).toContain('requestAnimationFrame(runNavigation);');
    expect(source).toContain("navigateFromViewer('/sign-in');");
    expect(source).toContain(
      'navigateFromViewer(`/user-profile?id=${encodeURIComponent(String(authorId))}`);'
    );
  });

  it('fetches ALL post types for the game (View All Posts), not highlights-only', () => {
    // 2026-07-14: the viewer must show every post type (photos/text/videos),
    // not just type:'highlight'. Guard against the videos-only filter returning.
    expect(source).toContain('{ game_id: gameId }');
    expect(source).not.toContain("type: 'highlight'");
    expect(source).toContain('const navigateToLinkedContext = useCallback(');
  });
});
