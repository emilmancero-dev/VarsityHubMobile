import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd());
const routeSource = readFileSync(join(ROOT, 'app/feed.tsx'), 'utf8');
const tabsBridgeSource = readFileSync(join(ROOT, 'app/(tabs)/feed/index.tsx'), 'utf8');

describe('feed route contracts', () => {
  it('hosts the canonical feed implementation at app/feed.tsx with the tab route bridging to it', () => {
    // app/feed.tsx is the single live implementation (the legacy
    // app/features/navigation/screens/FeedScreen.tsx was relocated here).
    expect(routeSource).toContain('export default function FeedScreen');
    expect(routeSource).not.toContain('features/navigation');
    // The (tabs) route stays a one-line bridge — one implementation, no duplication.
    expect(tabsBridgeSource.trim()).toBe("export { default } from '../../feed';");
  });

  it('paginates followed social post sections with independent feed bundle cursors', () => {
    expect(routeSource).toContain('followedPostsCursor');
    expect(routeSource).toContain('followedTeamsPostsCursor');
    expect(routeSource).toContain('posts_cursor: cursor');
    expect(routeSource).toContain('posts_followed_teams_cursor: cursor');
    expect(routeSource).toContain('feed-load-more-followed-posts');
    expect(routeSource).toContain('feed-load-more-team-posts');
  });

  it('surfaces partial feed bundle fallback warnings instead of treating them as true empties', () => {
    expect(routeSource).toContain('socialFeedWarning');
    expect(routeSource).toContain('feed-bundle-warning');
    expect(routeSource).toContain('Some feed sections could not load');
  });

  it('covers VarsityHub-wide games and event-only pages, not only local/pro fixtures', () => {
    expect(routeSource).toContain("fetchDiscoveryItems({ surface: 'feed' }");
    expect(routeSource).toContain("'feed-discovery'");
    expect(routeSource).toContain(
      "surface: 'feed', from: pastFrom.toISOString(), to: pastTo.toISOString()"
    );
  });
});
