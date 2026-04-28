import {
  calculateDistance,
  areTimesNearlyIdentical,
  areLocationsNearby,
  haveSameTeams,
  shouldMergeEvents,
  findMergeSuggestions,
  formatMergeSuggestion,
} from '../eventMerge';

describe('calculateDistance', () => {
  it('returns null when any coordinate is missing', () => {
    expect(calculateDistance(null, 0, 0, 0)).toBeNull();
    expect(calculateDistance(0, null, 0, 0)).toBeNull();
    expect(calculateDistance(0, 0, null, 0)).toBeNull();
    expect(calculateDistance(0, 0, 0, null)).toBeNull();
  });

  it('returns 0 for identical coordinates', () => {
    const dist = calculateDistance(40.7128, -74.006, 40.7128, -74.006);
    expect(dist).not.toBeNull();
    expect(dist!).toBeCloseTo(0, 1);
  });

  it('calculates approximate distance between NYC and LA (~3940 km)', () => {
    const dist = calculateDistance(40.7128, -74.006, 34.0522, -118.2437);
    expect(dist).not.toBeNull();
    // Should be roughly 3940 km = 3,940,000 meters ± 5%
    expect(dist!).toBeGreaterThan(3700000);
    expect(dist!).toBeLessThan(4200000);
  });

  it('calculates small distance correctly (< 150 m)', () => {
    // Approx 111 m apart (0.001 degree latitude ≈ 111 m)
    const dist = calculateDistance(40.7128, -74.006, 40.7138, -74.006);
    expect(dist).not.toBeNull();
    expect(dist!).toBeLessThan(150);
  });
});

describe('areTimesNearlyIdentical', () => {
  it('returns false when either date is missing', () => {
    expect(areTimesNearlyIdentical(null, '2024-01-01T10:00:00Z')).toBe(false);
    expect(areTimesNearlyIdentical('2024-01-01T10:00:00Z', null)).toBe(false);
  });

  it('returns false for invalid date strings', () => {
    expect(areTimesNearlyIdentical('not-a-date', '2024-01-01T10:00:00Z')).toBe(false);
  });

  it('returns true for identical timestamps', () => {
    const t = '2024-06-15T14:30:00Z';
    expect(areTimesNearlyIdentical(t, t)).toBe(true);
  });

  it('returns true for timestamps within 15 minutes', () => {
    expect(
      areTimesNearlyIdentical('2024-06-15T14:00:00Z', '2024-06-15T14:14:00Z')
    ).toBe(true);
  });

  it('returns false for timestamps more than 15 minutes apart', () => {
    expect(
      areTimesNearlyIdentical('2024-06-15T14:00:00Z', '2024-06-15T14:16:00Z')
    ).toBe(false);
  });

  it('respects custom threshold', () => {
    expect(
      areTimesNearlyIdentical('2024-06-15T14:00:00Z', '2024-06-15T14:30:00Z', 30)
    ).toBe(true);
  });
});

describe('areLocationsNearby', () => {
  it('returns false when either location is missing', () => {
    expect(areLocationsNearby(null, { latitude: 1, longitude: 1 })).toBe(false);
    expect(areLocationsNearby({ latitude: 1, longitude: 1 }, null)).toBe(false);
  });

  it('returns true for locations within 150 m', () => {
    const loc1 = { latitude: 40.7128, longitude: -74.006 };
    const loc2 = { latitude: 40.7129, longitude: -74.006 }; // ~11 m
    expect(areLocationsNearby(loc1, loc2)).toBe(true);
  });

  it('returns false for locations farther than 150 m', () => {
    const loc1 = { latitude: 40.7128, longitude: -74.006 };
    const loc2 = { latitude: 40.714, longitude: -74.006 }; // ~133 m... let's go further
    const loc3 = { latitude: 40.715, longitude: -74.006 }; // ~247 m
    expect(areLocationsNearby(loc1, loc3)).toBe(false);
  });

  it('falls back to address comparison when coordinates are missing', () => {
    const loc1 = { address: 'Madison Square Garden' };
    const loc2 = { address: 'Madison Square Garden' };
    expect(areLocationsNearby(loc1, loc2)).toBe(true);
  });

  it('returns false for different addresses with no coordinates', () => {
    const loc1 = { address: 'Venue A' };
    const loc2 = { address: 'Venue B' };
    expect(areLocationsNearby(loc1, loc2)).toBe(false);
  });

  it('address comparison is case-insensitive', () => {
    const loc1 = { address: 'MADISON SQUARE GARDEN' };
    const loc2 = { address: 'madison square garden' };
    expect(areLocationsNearby(loc1, loc2)).toBe(true);
  });
});

describe('haveSameTeams', () => {
  const teamA = { id: 'e1', team_id: 'teamA', opponent_team_id: 'teamB' };
  const teamB = { id: 'e2', team_id: 'teamB', opponent_team_id: 'teamA' };
  const teamC = { id: 'e3', team_id: 'teamC', opponent_team_id: 'teamD' };
  const missingTeam = { id: 'e4' };

  it('returns true for direct match', () => {
    expect(haveSameTeams(teamA, { id: 'e5', team_id: 'teamA', opponent_team_id: 'teamB' })).toBe(true);
  });

  it('returns true for reversed match (home/away swapped)', () => {
    expect(haveSameTeams(teamA, teamB)).toBe(true);
  });

  it('returns false for different teams', () => {
    expect(haveSameTeams(teamA, teamC)).toBe(false);
  });

  it('returns false when team_id is missing', () => {
    expect(haveSameTeams(missingTeam as any, teamA)).toBe(false);
  });
});

describe('shouldMergeEvents', () => {
  const now = new Date('2024-06-15T14:00:00Z').toISOString();
  const nearTime = new Date('2024-06-15T14:10:00Z').toISOString();
  const farTime = new Date('2024-06-15T15:00:00Z').toISOString();

  const nearLocation = { latitude: 40.7128, longitude: -74.006 };
  const sameLocation = { latitude: 40.7128, longitude: -74.006 };
  const farLocation = { latitude: 40.8, longitude: -74.1 };

  it('returns null for identical event IDs', () => {
    const event = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    expect(shouldMergeEvents(event, event)).toBeNull();
  });

  it('returns null when times differ by more than 15 min', () => {
    const e1 = { id: '1', date: now, location: nearLocation };
    const e2 = { id: '2', date: farTime, location: sameLocation };
    expect(shouldMergeEvents(e1, e2)).toBeNull();
  });

  it('returns null when locations are far apart', () => {
    const e1 = { id: '1', date: now, location: nearLocation };
    const e2 = { id: '2', date: nearTime, location: farLocation };
    expect(shouldMergeEvents(e1, e2)).toBeNull();
  });

  it('returns a merge suggestion with score >= 80 when time and location match', () => {
    const e1 = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e2 = { id: '2', date: nearTime, location: sameLocation, team_id: 'a', opponent_team_id: 'b' };
    const suggestion = shouldMergeEvents(e1, e2);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.matchScore).toBeGreaterThanOrEqual(80);
    expect(suggestion!.primaryEvent.id).toBe('1');
    expect(suggestion!.duplicateEvent.id).toBe('2');
  });

  it('includes team match reason when teams are the same', () => {
    const e1 = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e2 = { id: '2', date: nearTime, location: sameLocation, team_id: 'a', opponent_team_id: 'b' };
    const suggestion = shouldMergeEvents(e1, e2);
    expect(suggestion!.reasons).toContain('Same teams playing');
  });
});

describe('findMergeSuggestions', () => {
  const now = '2024-06-15T14:00:00Z';
  const nearTime = '2024-06-15T14:05:00Z';
  const nearLocation = { latitude: 40.7128, longitude: -74.006 };

  it('returns empty array for empty list', () => {
    expect(findMergeSuggestions([])).toEqual([]);
  });

  it('returns empty array for single event', () => {
    expect(findMergeSuggestions([{ id: '1', date: now, location: nearLocation }])).toEqual([]);
  });

  it('detects duplicate pair and returns suggestion', () => {
    const e1 = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e2 = { id: '2', date: nearTime, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const suggestions = findMergeSuggestions([e1, e2]);
    expect(suggestions.length).toBe(1);
  });

  it('sorts suggestions by matchScore descending', () => {
    const e1 = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e2 = { id: '2', date: nearTime, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e3 = { id: '3', date: now, location: nearLocation }; // no teams, lower score
    const e4 = { id: '4', date: nearTime, location: nearLocation };
    const suggestions = findMergeSuggestions([e1, e2, e3, e4]);
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].matchScore).toBeGreaterThanOrEqual(suggestions[i].matchScore);
    }
  });

  it('does not process the same pair twice', () => {
    const e1 = { id: '1', date: now, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const e2 = { id: '2', date: nearTime, location: nearLocation, team_id: 'a', opponent_team_id: 'b' };
    const suggestions = findMergeSuggestions([e1, e2, e1, e2]);
    // Even with duplicates in input, each pair should only appear once
    const pairKeys = suggestions.map(s => [s.primaryEvent.id, s.duplicateEvent.id].sort().join('-'));
    const unique = new Set(pairKeys);
    expect(unique.size).toBe(pairKeys.length);
  });
});

describe('formatMergeSuggestion', () => {
  it('formats suggestion with titles and score', () => {
    const suggestion = {
      primaryEvent: { id: '1', title: 'Game A' },
      duplicateEvent: { id: '2', title: 'Game B' },
      matchScore: 100,
      reasons: ['Same date/time (±15 min)', 'Same venue (<150m)'],
    };
    const result = formatMergeSuggestion(suggestion);
    expect(result).toContain('100%');
    expect(result).toContain('Game A');
    expect(result).toContain('Game B');
    expect(result).toContain('Same date/time (±15 min)');
  });

  it('uses fallback title when title is missing', () => {
    const suggestion = {
      primaryEvent: { id: '1' },
      duplicateEvent: { id: '2' },
      matchScore: 80,
      reasons: ['Same date/time (±15 min)'],
    };
    const result = formatMergeSuggestion(suggestion);
    expect(result).toContain('Event');
  });
});
