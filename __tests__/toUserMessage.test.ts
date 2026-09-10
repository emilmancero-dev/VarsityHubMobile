import {
  sanitizeMessage,
  toUserMessage,
  toAuthErrorMessage,
  apiHostFingerprint,
} from '@/utils/toUserMessage';

const GENERIC = 'Something went wrong. Please try again.';
const NETWORK = "Couldn't reach the server. Check your connection and try again.";

describe('sanitizeMessage', () => {
  it('passes through a clean server message', () => {
    expect(sanitizeMessage('You already have this subscription plan')).toBe(
      'You already have this subscription plan'
    );
  });

  it('falls back on empty / non-string', () => {
    expect(sanitizeMessage('')).toBe(GENERIC);
    expect(sanitizeMessage(undefined)).toBe(GENERIC);
    expect(sanitizeMessage(null)).toBe(GENERIC);
    expect(sanitizeMessage(42 as any)).toBe(GENERIC);
  });

  it('never leaks a URL, the Railway origin, or provider hosts', () => {
    expect(
      sanitizeMessage(
        'Cannot connect to server at https://api-production-8ac3.up.railway.app. Please check your internet connection and try again.'
      )
    ).toBe(GENERIC);
    expect(sanitizeMessage('Cloudinary upload failed: HTTP 401 — invalid signature')).toBe(GENERIC);
    expect(sanitizeMessage('failed to fetch https://res.cloudinary.com/x')).toBe(GENERIC);
  });

  it('never leaks a stack frame or source path', () => {
    expect(sanitizeMessage('TypeError: x\n    at load (app/feed.tsx:640:11)')).toBe(GENERIC);
  });

  it('falls back on over-long messages', () => {
    expect(sanitizeMessage('x'.repeat(201))).toBe(GENERIC);
  });

  it('honors a custom fallback', () => {
    expect(sanitizeMessage('', 'Unable to load games.')).toBe('Unable to load games.');
  });
});

describe('toUserMessage', () => {
  it('returns the fixed network string for transport errors, no host', () => {
    expect(
      toUserMessage({ isNetworkError: true, message: 'Cannot connect to server at https://x' })
    ).toBe(NETWORK);
    expect(toUserMessage({ status: 0, message: 'Cannot connect to server at https://x' })).toBe(
      NETWORK
    );
    expect(toUserMessage({ isNetworkError: true })).not.toMatch(/https?:\/\/|railway/i);
  });

  it('prefers the server envelope message when clean', () => {
    expect(toUserMessage({ data: { message: 'Posting is not open yet.' } })).toBe(
      'Posting is not open yet.'
    );
    expect(toUserMessage({ data: { error: 'That user is already on this team.' } })).toBe(
      'That user is already on this team.'
    );
  });

  it('sanitizes a leaky message even when not flagged as network', () => {
    expect(
      toUserMessage({ message: 'boom at https://api-production-8ac3.up.railway.app/games' })
    ).toBe(GENERIC);
  });
});

describe('toAuthErrorMessage', () => {
  it('appends a 4-hex fingerprint on transport failure and never the URL', () => {
    const msg = toAuthErrorMessage({ isNetworkError: true });
    expect(msg).toMatch(/^Couldn't reach the server \(ref [0-9a-f-]{4}\)\./);
    expect(msg).not.toMatch(/https?:\/\/|railway/i);
  });

  it('sanitizes non-transport errors like toUserMessage', () => {
    expect(toAuthErrorMessage({ message: 'Invalid credentials' })).toBe('Invalid credentials');
    expect(toAuthErrorMessage({ message: 'x https://railway.app' })).toBe(GENERIC);
  });
});

describe('apiHostFingerprint', () => {
  it('is stable and 4 hex chars for a given host', () => {
    const a = apiHostFingerprint('https://api-production-8ac3.up.railway.app');
    const b = apiHostFingerprint('https://api-production-8ac3.up.railway.app/');
    expect(a).toMatch(/^[0-9a-f]{4}$/);
    expect(a).toBe(b); // trailing slash / path stripped
  });

  it('differs across hosts', () => {
    expect(apiHostFingerprint('https://api-production-8ac3.up.railway.app')).not.toBe(
      apiHostFingerprint('http://localhost:4000')
    );
  });
});

describe('error disclosure protection', () => {
  it.each([
    'The operation couldn’t be completed. (PHPhotosErrorDomain error 3164.)',
    'password=private-value',
    'relation internal_users does not exist',
    'Unknown provider diagnostic with private-value',
    'Invalid credentials: private-value',
  ])('rejects unapproved text: %s', raw => {
    expect(sanitizeMessage(raw, 'Please try again.')).toBe('Please try again.');
    expect(toUserMessage({ data: { message: raw } }, 'Please try again.')).toBe(
      'Please try again.'
    );
    expect(toAuthErrorMessage(new Error(raw), 'Please try again.')).toBe('Please try again.');
  });
});

it('maps known business codes to helpful approved copy without echoing diagnostics', () => {
  expect(toUserMessage({ data: { code: 'SOLE_OWNER', message: 'private-value' } })).toBe(
    'Transfer ownership to another member before removing the only owner.'
  );
  expect(
    toUserMessage({ data: { error: 'MEDIA_DURATION_EXCEEDED', message: 'private-value' } })
  ).toBe('Stories are limited to 20 seconds. Trim this video and try again.');
});
