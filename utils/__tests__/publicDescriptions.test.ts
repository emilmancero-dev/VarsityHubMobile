import { describe, expect, it } from '@jest/globals';
import { sanitizePublicDescription, stripLinksFromDescription } from '@/utils/publicDescriptions';

describe('sanitizePublicDescription', () => {
  it('returns null for empty or placeholder descriptions', () => {
    expect(sanitizePublicDescription('')).toBeNull();
    expect(sanitizePublicDescription('   ')).toBeNull();
    expect(sanitizePublicDescription('Team Overview')).toBeNull();
    expect(sanitizePublicDescription('Welcome to the official team page for Westhill.')).toBeNull();
  });

  it('preserves real descriptions', () => {
    expect(sanitizePublicDescription('Competitive varsity basketball team in Stamford, CT.')).toBe(
      'Competitive varsity basketball team in Stamford, CT.'
    );
  });
});

describe('stripLinksFromDescription', () => {
  it('removes the "Official fixture: <url>" credit from ingested fixtures', () => {
    const raw =
      'MLS regular season: New York City FC vs Nashville SC at Yankee Stadium. ' +
      'Official fixture: https://www.newyorkcityfc.com/competitions/mls-regular-season';
    expect(stripLinksFromDescription(raw)).toBe(
      'MLS regular season: New York City FC vs Nashville SC at Yankee Stadium.'
    );
  });

  it('strips a bare URL anywhere in the text', () => {
    expect(stripLinksFromDescription('Watch here https://example.com/live tonight')).toBe(
      'Watch here tonight'
    );
  });

  it('leaves link-free descriptions untouched', () => {
    expect(stripLinksFromDescription('Homecoming game under the lights.')).toBe(
      'Homecoming game under the lights.'
    );
  });

  it('returns null for empty input or a description that was only a link', () => {
    expect(stripLinksFromDescription('')).toBeNull();
    expect(stripLinksFromDescription(null)).toBeNull();
    expect(stripLinksFromDescription('https://example.com')).toBeNull();
  });
});
