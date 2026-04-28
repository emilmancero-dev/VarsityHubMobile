import {
  isValidZipCode,
  normalizeZipCode,
  calculateDistanceMiles,
  findNearbyZipCodes,
  formatDistance,
  getCoverageDescription,
} from '../zipCodeUtils';

describe('isValidZipCode', () => {
  it('accepts US 5-digit zip', () => {
    expect(isValidZipCode('90210')).toBe(true);
  });

  it('accepts UK postal code', () => {
    expect(isValidZipCode('SW1A 1AA')).toBe(true);
  });

  it('accepts Canadian postal code', () => {
    expect(isValidZipCode('K1A 0B1')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidZipCode('')).toBe(false);
  });

  it('rejects single character', () => {
    expect(isValidZipCode('A')).toBe(false);
  });

  it('rejects string starting with special char', () => {
    expect(isValidZipCode('-12345')).toBe(false);
  });

  it('rejects string ending with special char', () => {
    expect(isValidZipCode('12345-')).toBe(false);
  });
});

describe('normalizeZipCode', () => {
  it('uppercases the input', () => {
    expect(normalizeZipCode('sw1a 1aa')).toBe('SW1A 1AA');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeZipCode('  90210  ')).toBe('90210');
  });

  it('preserves internal spaces and hyphens', () => {
    expect(normalizeZipCode('K1A 0B1')).toBe('K1A 0B1');
    expect(normalizeZipCode('12345-6789')).toBe('12345-6789');
  });
});

describe('calculateDistanceMiles', () => {
  it('returns ~0 for identical coordinates', () => {
    expect(calculateDistanceMiles(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 1);
  });

  it('calculates approximate distance between NYC and LA (~2445 miles)', () => {
    const dist = calculateDistanceMiles(40.7128, -74.006, 34.0522, -118.2437);
    expect(dist).toBeGreaterThan(2300);
    expect(dist).toBeLessThan(2600);
  });

  it('calculates small distance correctly (under 1 mile)', () => {
    // ~0.069 miles apart (0.001 degree latitude ≈ 69 miles, so 0.0001 ≈ 0.069)
    const dist = calculateDistanceMiles(40.7128, -74.006, 40.7129, -74.006);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(1);
  });
});

describe('findNearbyZipCodes', () => {
  const center = { zip: '10001', latitude: 40.7484, longitude: -73.9967 };
  const nearby = { zip: '10002', latitude: 40.7157, longitude: -73.9863 }; // ~2 miles
  const far = { zip: '90210', latitude: 34.0901, longitude: -118.4065 }; // ~2800 miles

  it('returns empty array when no zips are within radius', () => {
    const result = findNearbyZipCodes(center, [far], 20);
    expect(result).toHaveLength(0);
  });

  it('returns nearby zip within radius', () => {
    const result = findNearbyZipCodes(center, [nearby, far], 20);
    expect(result).toHaveLength(1);
    expect(result[0].zip).toBe('10002');
  });

  it('excludes the center zip itself', () => {
    const result = findNearbyZipCodes(center, [center, nearby], 20);
    const zips = result.map(z => z.zip);
    expect(zips).not.toContain('10001');
  });

  it('sorts results by distance ascending', () => {
    const mid = { zip: '10003', latitude: 40.73, longitude: -73.99 }; // between center and nearby
    const result = findNearbyZipCodes(center, [nearby, mid], 20);
    expect(result.length).toBe(2);
    expect(result[0].distance).toBeLessThanOrEqual(result[1].distance);
  });

  it('includes distance property in results', () => {
    const result = findNearbyZipCodes(center, [nearby], 20);
    expect(result[0]).toHaveProperty('distance');
    expect(typeof result[0].distance).toBe('number');
  });
});

describe('formatDistance', () => {
  it('formats distances under 1 mile in feet', () => {
    expect(formatDistance(0.5)).toContain('ft');
    expect(formatDistance(0.5)).toContain('2640'); // 0.5 * 5280
  });

  it('formats distances of 1 mile or more in miles', () => {
    expect(formatDistance(1)).toBe('1.0 mi');
    expect(formatDistance(2.5)).toBe('2.5 mi');
  });

  it('formats exactly 0 distance as feet', () => {
    expect(formatDistance(0)).toContain('ft');
  });
});

describe('getCoverageDescription', () => {
  it('includes the zip code in the description', () => {
    const desc = getCoverageDescription('90210');
    expect(desc).toContain('90210');
  });

  it('includes the default radius (20 miles) in the description', () => {
    const desc = getCoverageDescription('90210');
    expect(desc).toContain('20');
  });

  it('uses custom radius when provided', () => {
    const desc = getCoverageDescription('90210', 50);
    expect(desc).toContain('50');
  });
});
