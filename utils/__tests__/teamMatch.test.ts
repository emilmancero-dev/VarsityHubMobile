import { normalizeName, findBestMatch } from '../teamMatch';

describe('normalizeName', () => {
  it('returns empty string for null/undefined', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
  });

  it('lowercases the input', () => {
    expect(normalizeName('TIGERS')).toBe('tigers');
  });

  it('removes non-alphanumeric characters except spaces', () => {
    expect(normalizeName("St. John's")).toBe('st john s');
    expect(normalizeName('Team-Alpha!')).toBe('team alpha');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeName('New   York  Knights')).toBe('new york knights');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  bears  ')).toBe('bears');
  });
});

describe('findBestMatch', () => {
  const teams = [
    { id: '1', name: 'Springfield Tigers' },
    { id: '2', name: 'Riverside Knights' },
    { id: '3', name: 'Lakewood Bears' },
    { id: '4', name: 'Northside Wolves' },
  ];

  it('returns null for empty or null target name', () => {
    expect(findBestMatch(null, teams)).toBeNull();
    expect(findBestMatch('', teams)).toBeNull();
    expect(findBestMatch(undefined, teams)).toBeNull();
  });

  it('returns null for empty teams array', () => {
    expect(findBestMatch('Tigers', [])).toBeNull();
  });

  it('returns exact match', () => {
    const result = findBestMatch('Springfield Tigers', teams);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
  });

  it('matches by prefix', () => {
    const result = findBestMatch('Riverside', teams);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('2');
  });

  it('matches when target contains team name', () => {
    const result = findBestMatch('The Lakewood Bears FC', teams);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('3');
  });

  it('returns fuzzy match for slight typo', () => {
    // "Northside Wolfs" is close to "Northside Wolves"
    const result = findBestMatch('Northside Wolfs', teams);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('4');
  });

  it('returns null when no team is close enough', () => {
    const result = findBestMatch('Completely Different Name XYZ', teams);
    expect(result).toBeNull();
  });

  it('is case-insensitive', () => {
    const result = findBestMatch('SPRINGFIELD TIGERS', teams);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
  });
});
