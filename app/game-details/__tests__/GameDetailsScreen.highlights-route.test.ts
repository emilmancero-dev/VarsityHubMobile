import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'app', 'game-details', 'GameDetailsScreen.tsx'),
  'utf8'
);

describe('GameDetailsScreen post route contract', () => {
  it('creates normal event posts from the game details Posts action', () => {
    expect(source).toContain("pathname: '/create-post'");
    expect(source).toContain('gameId: String(vm.gameId)');
    expect(source).toContain('eventId: String(vm.eventId)');
    expect(source).toContain("{ eventId: String(vm?.eventId), type: 'post' }");
    expect(source).not.toContain("{ eventId: String(vm?.eventId), type: 'highlight' }");
    expect(source).not.toContain("params: { gameId: String(targetGameId), type: 'highlight' },");
  });

  it('keeps story writes out of the Posts action', () => {
    const postActionStart = source.indexOf("Alert.alert('Create Post'");
    const postActionEnd = source.indexOf('</Pressable>', postActionStart);
    const postActionSource = source.slice(postActionStart, postActionEnd);

    expect(postActionStart).toBeGreaterThan(-1);
    expect(postActionEnd).toBeGreaterThan(postActionStart);
    expect(postActionSource).toContain("pathname: '/create-post'");
    expect(postActionSource).toContain("type: 'post'");
    expect(postActionSource).not.toContain('Game.addStory');
    expect(postActionSource).not.toContain("type: 'highlight'");
  });

  it('does not render standalone event posts as stories', () => {
    const virtualEventStart = source.indexOf('const loadVirtualFromEvent = useCallback');
    const virtualEventEnd = source.indexOf('const handleAddStory = useCallback', virtualEventStart);
    const virtualEventSource = source.slice(virtualEventStart, virtualEventEnd);

    expect(virtualEventStart).toBeGreaterThan(-1);
    expect(virtualEventEnd).toBeGreaterThan(virtualEventStart);
    expect(virtualEventSource).toContain('Post.getByEvent(eventIdValue)');
    expect(virtualEventSource).toContain('return { ...prev, posts: items };');
    const storyHydration = virtualEventSource.indexOf('Event.stories(eventIdValue)');
    expect(storyHydration).toBeGreaterThan(-1);
    const postHydration = virtualEventSource.slice(0, storyHydration);
    expect(postHydration).not.toContain('media: items');
    expect(virtualEventSource.slice(storyHydration)).toContain('return { ...prev, media: items };');
    expect(virtualEventSource).not.toContain('return { ...prev, posts: items, media }');
  });

  // REGRESSION GUARD: event pages show all event posts, not just legacy
  // `highlight` rows. A type-filtered query silently hides normal uploads
  // and legacy null-type rows. The game feed must fetch via feedForGame with
  // no type predicate.
  it('hydrates the game feed WITHOUT filtering on post type', () => {
    expect(source).toContain('Post.feedForGame(gameIdValue');
    expect(source).not.toContain("{ game_id: gameIdValue, type: 'highlight' }");
    expect(source).not.toContain("params: { gameId: String(targetGameId), type: 'post' },");
  });
});
