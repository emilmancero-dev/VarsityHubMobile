import {
  sanitizeText,
  sanitizeEmail,
  sanitizeUsername,
  validateEmail,
  validatePassword,
  calculatePasswordStrength,
  validateUsername,
  validateDisplayName,
  validateBio,
  validateTextField,
  validateZipCode,
  validatePhone,
  validateYear,
  validateUrl,
  validateNumber,
  preventNegative,
  hasErrors,
  clearFieldError,
  DISPLAY_NAME_MAX_LENGTH,
  BIO_MAX_LENGTH,
} from '../formUtils';

describe('sanitizeText', () => {
  it('removes angle brackets', () => {
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
  });

  it('removes javascript: protocol', () => {
    expect(sanitizeText('javascript:alert(1)')).toBe('alert(1)');
  });

  it('removes inline event handlers', () => {
    expect(sanitizeText('onclick=evil()')).toBe('evil()');
    expect(sanitizeText('onmouseover=bad()')).toBe('bad()');
  });

  it('trims whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeText('')).toBe('');
    expect(sanitizeText(null as any)).toBe('');
  });

  it('preserves normal text', () => {
    expect(sanitizeText('Hello World')).toBe('Hello World');
  });
});

describe('sanitizeEmail', () => {
  it('lowercases and trims', () => {
    expect(sanitizeEmail('  TEST@EXAMPLE.COM  ')).toBe('test@example.com');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeEmail('')).toBe('');
  });
});

describe('sanitizeUsername', () => {
  it('lowercases, removes disallowed chars, limits to 20 chars', () => {
    expect(sanitizeUsername('Hello_World!')).toBe('hello_world');
    expect(sanitizeUsername('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('abcdefghijklmnopqrstu'.slice(0, 20));
  });

  it('allows dots and underscores', () => {
    expect(sanitizeUsername('john.doe_99')).toBe('john.doe_99');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeUsername('')).toBe('');
  });
});

describe('validateEmail', () => {
  it('rejects empty email', () => {
    const result = validateEmail('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Email is required');
  });

  it('rejects malformed email', () => {
    expect(validateEmail('notanemail').valid).toBe(false);
    expect(validateEmail('missing@tld').valid).toBe(false);
    expect(validateEmail('@nodomain.com').valid).toBe(false);
  });

  it('accepts valid emails', () => {
    expect(validateEmail('user@example.com').valid).toBe(true);
    expect(validateEmail('user+tag@sub.domain.org').valid).toBe(true);
  });
});

describe('validatePassword', () => {
  it('rejects empty password', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Password is required');
  });

  it('rejects password below minLength', () => {
    const result = validatePassword('abc1', 8);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('8 characters');
  });

  it('rejects password missing a letter', () => {
    const result = validatePassword('12345678', 8, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('letter');
  });

  it('rejects password missing a number', () => {
    const result = validatePassword('onlyletters', 8, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('number');
  });

  it('accepts valid strong password', () => {
    expect(validatePassword('abc12345', 8, true).valid).toBe(true);
  });

  it('skips strength check when requireStrong is false', () => {
    expect(validatePassword('aaaaaaaa', 8, false).valid).toBe(true);
  });
});

describe('calculatePasswordStrength', () => {
  it('returns score 0 for empty password', () => {
    const { score, feedback } = calculatePasswordStrength('');
    expect(score).toBe(0);
    expect(feedback).toBe('Very weak');
  });

  it('increases score with length >= 8', () => {
    const { score } = calculatePasswordStrength('abcdefgh');
    expect(score).toBeGreaterThan(0);
  });

  it('returns maximum score 4 for strong password', () => {
    const { score, feedback } = calculatePasswordStrength('Abc123!@#xyz');
    expect(score).toBe(4);
    expect(feedback).toBe('Strong');
  });

  it('gives higher score for longer password', () => {
    const short = calculatePasswordStrength('Abc1!');
    const long = calculatePasswordStrength('Abc123456789!');
    expect(long.score).toBeGreaterThanOrEqual(short.score);
  });
});

describe('validateUsername', () => {
  it('rejects empty username', () => {
    expect(validateUsername('').valid).toBe(false);
  });

  it('rejects username shorter than 3 chars', () => {
    expect(validateUsername('ab').valid).toBe(false);
  });

  it('rejects username longer than 20 chars', () => {
    expect(validateUsername('a'.repeat(21)).valid).toBe(false);
  });

  it('rejects uppercase characters', () => {
    expect(validateUsername('UserName').valid).toBe(false);
  });

  it('rejects spaces', () => {
    expect(validateUsername('user name').valid).toBe(false);
  });

  it('accepts valid usernames', () => {
    expect(validateUsername('john_doe').valid).toBe(true);
    expect(validateUsername('user.name99').valid).toBe(true);
    expect(validateUsername('abc').valid).toBe(true);
  });
});

describe('validateDisplayName', () => {
  it('returns valid for empty display name (optional field)', () => {
    expect(validateDisplayName('').valid).toBe(true);
  });

  it('returns valid for blank whitespace (optional field)', () => {
    expect(validateDisplayName('   ').valid).toBe(true);
  });

  it('rejects display name exceeding max length', () => {
    const result = validateDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`${DISPLAY_NAME_MAX_LENGTH}`);
  });

  it('accepts display name within limit', () => {
    expect(validateDisplayName('John Doe').valid).toBe(true);
  });
});

describe('validateBio', () => {
  it('returns valid for empty bio (optional)', () => {
    expect(validateBio('').valid).toBe(true);
  });

  it('rejects bio exceeding max length', () => {
    const result = validateBio('a'.repeat(BIO_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`${BIO_MAX_LENGTH}`);
  });

  it('accepts bio within limit', () => {
    expect(validateBio('I love sports!').valid).toBe(true);
  });
});

describe('validateTextField', () => {
  it('rejects empty required field', () => {
    const result = validateTextField('', 'Title', { required: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Title');
  });

  it('accepts empty optional field', () => {
    expect(validateTextField('', 'Title', { required: false }).valid).toBe(true);
  });

  it('rejects value below minLength', () => {
    const result = validateTextField('hi', 'Name', { minLength: 5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5');
  });

  it('rejects value above maxLength', () => {
    const result = validateTextField('toolongvalue', 'Name', { maxLength: 5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5');
  });

  it('accepts value within bounds', () => {
    expect(validateTextField('hello', 'Name', { minLength: 3, maxLength: 10 }).valid).toBe(true);
  });
});

describe('validateZipCode', () => {
  it('returns valid for empty zip (optional)', () => {
    expect(validateZipCode('').valid).toBe(true);
  });

  it('accepts 5-digit zip', () => {
    expect(validateZipCode('90210').valid).toBe(true);
  });

  it('rejects non-5-digit zip', () => {
    expect(validateZipCode('9021').valid).toBe(false);
    expect(validateZipCode('902100').valid).toBe(false);
    expect(validateZipCode('ABCDE').valid).toBe(false);
  });
});

describe('validatePhone', () => {
  it('returns valid for empty phone (optional)', () => {
    expect(validatePhone('').valid).toBe(true);
  });

  it('accepts valid 10-digit numbers with formatting', () => {
    expect(validatePhone('(555) 123-4567').valid).toBe(true);
    expect(validatePhone('5551234567').valid).toBe(true);
  });

  it('accepts 11-digit numbers (with country code)', () => {
    expect(validatePhone('15551234567').valid).toBe(true);
  });

  it('rejects too-short phone numbers', () => {
    expect(validatePhone('12345').valid).toBe(false);
  });
});

describe('validateYear', () => {
  it('returns valid for empty year (optional)', () => {
    expect(validateYear('').valid).toBe(true);
  });

  it('accepts valid years within default range', () => {
    expect(validateYear('2025').valid).toBe(true);
    expect(validateYear('1990').valid).toBe(true);
  });

  it('rejects non-numeric input', () => {
    expect(validateYear('abcd').valid).toBe(false);
  });

  it('rejects years outside custom range', () => {
    expect(validateYear('1990', { min: 2000, max: 2030 }).valid).toBe(false);
    expect(validateYear('2031', { min: 2000, max: 2030 }).valid).toBe(false);
  });
});

describe('validateUrl', () => {
  it('returns valid for empty url (optional)', () => {
    expect(validateUrl('').valid).toBe(true);
  });

  it('accepts valid URLs', () => {
    expect(validateUrl('https://example.com').valid).toBe(true);
    expect(validateUrl('http://sub.domain.org/path?q=1').valid).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(validateUrl('not a url').valid).toBe(false);
    expect(validateUrl('ftp//missing-colon.com').valid).toBe(false);
  });
});

describe('validateNumber', () => {
  it('returns valid for empty value (optional)', () => {
    expect(validateNumber('').valid).toBe(true);
  });

  it('rejects non-numeric input', () => {
    expect(validateNumber('abc').valid).toBe(false);
  });

  it('rejects non-integer when integer option is true', () => {
    expect(validateNumber('3.5', { integer: true }).valid).toBe(false);
  });

  it('rejects values below min', () => {
    expect(validateNumber('5', { min: 10 }).valid).toBe(false);
  });

  it('rejects values above max', () => {
    expect(validateNumber('20', { max: 10 }).valid).toBe(false);
  });

  it('accepts valid number within range', () => {
    expect(validateNumber('7', { min: 1, max: 10 }).valid).toBe(true);
  });
});

describe('preventNegative', () => {
  it('converts negative number to 0', () => {
    expect(preventNegative('-5')).toBe('0');
  });

  it('leaves non-negative values unchanged', () => {
    expect(preventNegative('10')).toBe('10');
    expect(preventNegative('0')).toBe('0');
  });

  it('leaves non-numeric values unchanged', () => {
    expect(preventNegative('abc')).toBe('abc');
  });
});

describe('hasErrors', () => {
  it('returns true when errors exist', () => {
    expect(hasErrors({ name: 'Required', email: undefined })).toBe(true);
  });

  it('returns false when all errors are undefined', () => {
    expect(hasErrors({ name: undefined, email: undefined })).toBe(false);
  });

  it('returns false for empty error object', () => {
    expect(hasErrors({})).toBe(false);
  });
});

describe('clearFieldError', () => {
  it('removes the specified field from errors', () => {
    const errors = { name: 'Required', email: 'Invalid' };
    const result = clearFieldError(errors, 'name');
    expect(result).not.toHaveProperty('name');
    expect(result.email).toBe('Invalid');
  });

  it('returns unchanged object when field does not exist', () => {
    const errors = { email: 'Invalid' };
    const result = clearFieldError(errors, 'name');
    expect(result).toEqual({ email: 'Invalid' });
  });
});
