import { adultBirthDateCutoff, isVerifiedAdult } from '../lib/userAge.js';

test.each(['2026-09-17T00:00:00Z', '2028-02-29T23:59:00Z', '2026-03-01T12:00:00Z'])(
  'discovery cutoff agrees with canonical adult age at %s',
  value => {
    const now = new Date(value);
    const cutoff = adultBirthDateCutoff(now);
    const next = new Date(cutoff);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(isVerifiedAdult({ date_of_birth: cutoff }, now)).toBe(true);
    expect(isVerifiedAdult({ date_of_birth: next }, now)).toBe(false);
  }
);
