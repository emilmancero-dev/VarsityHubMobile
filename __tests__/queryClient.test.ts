import { CACHE_BUSTER, shouldPersistQuery } from '@/lib/queryClient';

describe('query cache persistence policy', () => {
  it('bumps the persisted cache when the persistence policy changes', () => {
    expect(CACHE_BUSTER).toBe('vh-rq-3');
  });

  it('keeps large volatile timelines out of AsyncStorage hydration', () => {
    expect(
      shouldPersistQuery({ queryKey: ['feed-games-upcoming'], state: { status: 'success' } })
    ).toBe(false);
    expect(shouldPersistQuery({ queryKey: ['discover-games'], state: { status: 'success' } })).toBe(
      false
    );
    expect(
      shouldPersistQuery({ queryKey: ['profile-posts', 'user-1'], state: { status: 'success' } })
    ).toBe(false);
  });

  it('still persists smaller stable detail queries', () => {
    expect(
      shouldPersistQuery({ queryKey: ['team-page', 'team-1'], state: { status: 'success' } })
    ).toBe(true);
    expect(
      shouldPersistQuery({ queryKey: ['game-summary', 'game-1'], state: { status: 'success' } })
    ).toBe(true);
  });
});
