import { isSessionExpiryError } from '../sessionExpiryError';

describe('isSessionExpiryError', () => {
  it('returns true when isSessionExpired flag is set', () => {
    expect(isSessionExpiryError({ isSessionExpired: true })).toBe(true);
  });

  it('returns true for 401 with "session expired" in error field', () => {
    expect(
      isSessionExpiryError({ status: 401, data: { error: 'Session expired' } })
    ).toBe(true);
  });

  it('returns true for 401 with "session expired" in message field', () => {
    expect(
      isSessionExpiryError({ status: 401, data: { message: 'Your session expired' } })
    ).toBe(true);
  });

  it('returns true for 401 with session expired via response.status and response.data', () => {
    expect(
      isSessionExpiryError({
        response: { status: 401, data: { error: 'session expired please log in' } },
      })
    ).toBe(true);
  });

  it('returns false for 401 without "session expired" in message', () => {
    expect(
      isSessionExpiryError({ status: 401, data: { error: 'Unauthorized' } })
    ).toBe(false);
  });

  it('returns false for non-401 status codes', () => {
    expect(
      isSessionExpiryError({ status: 403, data: { error: 'session expired' } })
    ).toBe(false);
  });

  it('returns false for null/undefined error', () => {
    expect(isSessionExpiryError(null)).toBe(false);
    expect(isSessionExpiryError(undefined)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isSessionExpiryError({})).toBe(false);
  });

  it('returns false when isSessionExpired is false', () => {
    expect(isSessionExpiryError({ isSessionExpired: false })).toBe(false);
  });

  it('handles err.message fallback', () => {
    expect(
      isSessionExpiryError({ status: 401, message: 'session expired' })
    ).toBe(true);
  });
});
