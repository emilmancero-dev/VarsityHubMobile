import { calculateRanking, shouldShowBadge } from '../rankingUtils';
import type { HighlightItem } from '../rankingUtils';

const makeItem = (overrides: Partial<HighlightItem> = {}): HighlightItem => ({
  id: 'item-1',
  created_at: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
  author_id: 'user-1',
  upvotes_count: 0,
  ...overrides,
});

describe('calculateRanking', () => {
  const emptyList: HighlightItem[] = [];

  it('returns trending badge for trending tab', () => {
    const item = makeItem();
    const result = calculateRanking(item, 0, 'trending', emptyList, emptyList);
    expect(result.type).toBe('trending');
    expect(result.show).toBe(true);
  });

  it('returns recent badge for recent tab', () => {
    const item = makeItem();
    const result = calculateRanking(item, 0, 'recent', emptyList, emptyList);
    expect(result.type).toBe('recent');
    expect(result.show).toBe(true);
  });

  it('returns top badge for top tab', () => {
    const item = makeItem();
    const result = calculateRanking(item, 0, 'top', emptyList, emptyList);
    expect(result.type).toBe('top');
    expect(result.show).toBe(true);
  });

  it('returns show: false for unknown tab', () => {
    const item = makeItem();
    const result = calculateRanking(item, 0, 'unknown_tab', emptyList, emptyList);
    expect(result.show).toBe(false);
  });
});

describe('shouldShowBadge', () => {
  const emptyList: HighlightItem[] = [];

  it('returns true for trending tab', () => {
    const item = makeItem();
    expect(shouldShowBadge(item, 0, 'trending', emptyList, emptyList)).toBe(true);
  });

  it('returns true for recent tab', () => {
    const item = makeItem();
    expect(shouldShowBadge(item, 0, 'recent', emptyList, emptyList)).toBe(true);
  });

  it('returns true for top tab', () => {
    const item = makeItem();
    expect(shouldShowBadge(item, 0, 'top', emptyList, emptyList)).toBe(true);
  });

  it('returns false for unknown tab', () => {
    const item = makeItem();
    expect(shouldShowBadge(item, 0, 'unknown_tab', emptyList, emptyList)).toBe(false);
  });
});
