import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'app', 'game-details', 'GameDetailsScreen.tsx'),
  'utf8'
);

describe('GameDetailsScreen banner fallback contract', () => {
  it('never promotes attendee media into the event hero banner fallback', () => {
    // Venue artwork is an intentional fallback (154c4ace); attendee media is not.
    expect(source).toContain(
      'const bannerImageUrl = finalsBanner || bannerUrl || resolvedVenuePhotoUrl'
    );
    expect(source).toContain('return pickBannerFromArrays(vm ?? {})');
    expect(source).not.toContain('media[0]?.url');
  });
});
