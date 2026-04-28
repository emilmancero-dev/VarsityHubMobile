import { shouldShowEventOnMap } from '../mapEventFilters';

describe('shouldShowEventOnMap', () => {
  it('returns true when dateValue is null', () => {
    expect(shouldShowEventOnMap(null)).toBe(true);
  });

  it('returns true when dateValue is undefined', () => {
    expect(shouldShowEventOnMap(undefined)).toBe(true);
  });

  it('returns true when dateValue is an invalid date string', () => {
    expect(shouldShowEventOnMap('not-a-date')).toBe(true);
  });

  it('returns true for a future date', () => {
    const future = new Date(Date.now() + 86400_000).toISOString(); // tomorrow
    expect(shouldShowEventOnMap(future)).toBe(true);
  });

  it('returns false for a past date', () => {
    const past = new Date(Date.now() - 86400_000).toISOString(); // yesterday
    expect(shouldShowEventOnMap(past)).toBe(false);
  });

  it('accepts a custom "now" reference date', () => {
    const eventDate = '2024-06-15T12:00:00Z';
    const before = new Date('2024-06-15T11:00:00Z');
    const after = new Date('2024-06-15T13:00:00Z');
    expect(shouldShowEventOnMap(eventDate, before)).toBe(true);
    expect(shouldShowEventOnMap(eventDate, after)).toBe(false);
  });

  it('returns true for an event exactly at "now"', () => {
    const now = new Date('2024-06-15T12:00:00.000Z');
    const eventDate = '2024-06-15T12:00:00.000Z';
    // parsed >= now when they are equal
    expect(shouldShowEventOnMap(eventDate, now)).toBe(true);
  });
});
