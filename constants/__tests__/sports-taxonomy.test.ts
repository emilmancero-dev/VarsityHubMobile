import { describe, expect, it } from '@jest/globals';
import taxonomy from '../../shared/sports-taxonomy.json';

describe('sports taxonomy', () => {
  it('labels the wrestling slug as Combat Sports, not Wrestling', () => {
    const entry = taxonomy.sports.find(s => s.slug === 'wrestling');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Combat Sports');
  });

  it('keeps the wrestling slug unchanged (data/back-compat)', () => {
    const entry = taxonomy.sports.find(s => s.slug === 'wrestling');
    expect(entry?.slug).toBe('wrestling');
  });
});
