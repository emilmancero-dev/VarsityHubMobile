import {
  HAS_POSTS_COLOR,
  LEAGUE_LEVEL_COLORS,
  PRESENT_AT_VENUE_COLOR,
  resolveMarkerColor,
} from '@/utils/mapMarkerColor';

describe('resolveMarkerColor', () => {
  it('colors by league tier by default', () => {
    expect(resolveMarkerColor({ league_level: 'major' })).toBe(LEAGUE_LEVEL_COLORS.major);
    expect(resolveMarkerColor({ league_level: 'minor' })).toBe(LEAGUE_LEVEL_COLORS.minor);
    expect(resolveMarkerColor({ league_level: 'college' })).toBe(LEAGUE_LEVEL_COLORS.college);
    expect(resolveMarkerColor({ league_level: null })).toBe(LEAGUE_LEVEL_COLORS.other);
  });

  it('overrides tier with gold when the page has posts', () => {
    expect(resolveMarkerColor({ has_posts: true, league_level: 'major' })).toBe(HAS_POSTS_COLOR);
  });

  it('overrides everything, including has_posts, when the viewer is present at the venue', () => {
    expect(resolveMarkerColor({ has_posts: true, league_level: 'major' }, true)).toBe(
      PRESENT_AT_VENUE_COLOR
    );
    expect(resolveMarkerColor({ league_level: 'college' }, true)).toBe(PRESENT_AT_VENUE_COLOR);
  });

  it('falsy isPresent falls through to the normal precedence', () => {
    expect(resolveMarkerColor({ league_level: 'major' }, false)).toBe(LEAGUE_LEVEL_COLORS.major);
  });
});
