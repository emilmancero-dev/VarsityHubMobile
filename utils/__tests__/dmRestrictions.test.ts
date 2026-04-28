import { calculateAge, isMinor, isVerifiedCoach, isAdmin, checkDMRestriction } from '../dmRestrictions';

// Helper to build a DOB string N years ago from today
function dobYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

describe('calculateAge', () => {
  it('returns null for null/undefined input', () => {
    expect(calculateAge(null)).toBeNull();
    expect(calculateAge(undefined)).toBeNull();
  });

  it('calculates age correctly', () => {
    const age = calculateAge(dobYearsAgo(25));
    expect(age).toBe(25);
  });

  it('handles birthday not yet reached this year', () => {
    // Create a birthday that is tomorrow (has not occurred yet this year)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const birthYear = tomorrow.getFullYear() - 20;
    const dob = new Date(birthYear, tomorrow.getMonth(), tomorrow.getDate()).toISOString();
    const age = calculateAge(dob);
    expect(age).toBe(19); // One day before 20th birthday
  });

  it('accepts Date object', () => {
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 30);
    expect(calculateAge(dob)).toBe(30);
  });
});

describe('isMinor', () => {
  it('returns true for someone under 18', () => {
    expect(isMinor(dobYearsAgo(15))).toBe(true);
  });

  it('returns false for someone exactly 18', () => {
    expect(isMinor(dobYearsAgo(18))).toBe(false);
  });

  it('returns false for someone over 18', () => {
    expect(isMinor(dobYearsAgo(25))).toBe(false);
  });

  it('returns false for null DOB', () => {
    expect(isMinor(null)).toBe(false);
  });
});

describe('isVerifiedCoach', () => {
  it('returns true for verified coach (preferences.role)', () => {
    const user = { preferences: { role: 'coach' }, is_verified: true };
    expect(isVerifiedCoach(user)).toBe(true);
  });

  it('returns true for verified coach (top-level role)', () => {
    const user = { role: 'coach', coach_verified: true };
    expect(isVerifiedCoach(user)).toBe(true);
  });

  it('returns false for coach without verification', () => {
    const user = { preferences: { role: 'coach' }, is_verified: false };
    expect(isVerifiedCoach(user)).toBe(false);
  });

  it('returns false for non-coach', () => {
    const user = { role: 'player', is_verified: true };
    expect(isVerifiedCoach(user)).toBe(false);
  });

  it('returns false for null/undefined user', () => {
    expect(isVerifiedCoach(null)).toBe(false);
    expect(isVerifiedCoach(undefined)).toBe(false);
  });
});

describe('isAdmin', () => {
  it('returns true for is_admin: true', () => {
    expect(isAdmin({ is_admin: true })).toBe(true);
  });

  it('returns true for super_admin role', () => {
    expect(isAdmin({ role: 'super_admin' })).toBe(true);
  });

  it('returns false for non-admin user', () => {
    expect(isAdmin({ role: 'player', is_admin: false })).toBe(false);
  });

  it('returns false for null user', () => {
    expect(isAdmin(null)).toBe(false);
  });
});

describe('checkDMRestriction', () => {
  const adult = { date_of_birth: dobYearsAgo(25) };
  const minor = { date_of_birth: dobYearsAgo(15) };
  const verifiedCoach = { date_of_birth: dobYearsAgo(35), preferences: { role: 'coach' }, is_verified: true };
  const admin = { is_admin: true };

  it('allows messaging when sender is admin', () => {
    const result = checkDMRestriction(admin, minor);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('admin_bypass');
  });

  it('allows messaging when recipient is admin', () => {
    const result = checkDMRestriction(minor, admin);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('admin_bypass');
  });

  it('allows adult-to-adult messaging', () => {
    const result = checkDMRestriction(adult, { date_of_birth: dobYearsAgo(30) });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows minor-to-minor messaging', () => {
    const result = checkDMRestriction(minor, { date_of_birth: dobYearsAgo(16) });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('both_minors');
  });

  it('blocks adult-to-minor messaging', () => {
    const result = checkDMRestriction(adult, minor);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('adult_to_minor');
    expect(result.showWarning).toBe(true);
    expect(result.warningMessage).toBeTruthy();
  });

  it('allows verified coach to message minor', () => {
    const result = checkDMRestriction(verifiedCoach, minor);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('coach_verified');
  });

  it('blocks minor from messaging adult', () => {
    const result = checkDMRestriction(minor, adult);
    expect(result.allowed).toBe(false);
    expect(result.showWarning).toBe(true);
  });

  it('allows minor to message verified coach', () => {
    const result = checkDMRestriction(minor, verifiedCoach);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('coach_verified');
  });

  it('falls back to allowed when ages cannot be determined', () => {
    const result = checkDMRestriction({}, {});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('includes coach verification prompt in warning when sender role is coach', () => {
    const unverifiedCoach = {
      date_of_birth: dobYearsAgo(30),
      preferences: { role: 'coach' },
      is_verified: false,
    };
    const result = checkDMRestriction(unverifiedCoach, minor);
    expect(result.allowed).toBe(false);
    expect(result.warningMessage).toContain('coach');
  });
});
