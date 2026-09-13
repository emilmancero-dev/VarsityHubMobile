import { shouldShowEventOnMap } from '../utils/mapEventFilters';

describe('shouldShowEventOnMap', () => {
  const now = new Date('2026-04-22T12:00:00.000Z');

  it('keeps future events on the map', () => {
    expect(shouldShowEventOnMap('2026-04-22T12:00:01.000Z', now)).toBe(true);
  });

  it('drops events more than two weeks in the future', () => {
    expect(shouldShowEventOnMap('2026-05-06T12:00:00.000Z', now)).toBe(true);
    expect(shouldShowEventOnMap('2026-05-06T12:00:01.000Z', now)).toBe(false);
    expect(shouldShowEventOnMap('2026-06-22T12:00:00.000Z', now)).toBe(false);
  });

  it('keeps a game still in progress within the default 3h live grace', () => {
    expect(shouldShowEventOnMap('2026-04-22T09:00:01.000Z', now)).toBe(true);
    expect(shouldShowEventOnMap('2026-04-22T09:00:00.000Z', now)).toBe(true);
  });

  it('drops events past the live grace window', () => {
    expect(shouldShowEventOnMap('2026-04-22T08:59:59.000Z', now)).toBe(false);
  });

  it('fails open for missing or invalid dates', () => {
    expect(shouldShowEventOnMap(undefined, now)).toBe(true);
    expect(shouldShowEventOnMap('not-a-date', now)).toBe(true);
  });
});
