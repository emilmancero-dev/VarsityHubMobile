/**
 * API error normalization — contract tests.
 *
 * Pins the behavior of `extractApiError` across the four shapes the app
 * actually catches: raw axios, unwrapped api-client, fetch, plain Error.
 * If a future refactor changes precedence or swallows a field, these
 * tests fail loudly.
 */
import { describe, expect, it } from '@jest/globals';
import { extractApiError, apiErrorMessage, apiErrorStatus, apiErrorCode } from '../utils/apiErrors';

describe('extractApiError — shape handling', () => {
  it('handles raw axios error (err.response.status / err.response.data)', () => {
    const err = {
      response: {
        status: 429,
        data: { code: 'RATE_LIMIT', message: 'Slow down.' },
      },
      message: 'Request failed with status code 429',
    };
    const out = extractApiError(err);
    expect(out.status).toBe(429);
    expect(out.code).toBe('RATE_LIMIT');
    expect(out.message).toBe('Something went wrong. Please try again.');
  });

  it('handles api-client unwrapped error (err.status / err.data)', () => {
    const err = {
      status: 403,
      data: { error: 'AGE_REQUIREMENT', message: 'You must be 18+.' },
    };
    const out = extractApiError(err);
    expect(out.status).toBe(403);
    expect(out.code).toBe('AGE_REQUIREMENT');
    expect(out.message).toBe('Something went wrong. Please try again.');
  });

  it('prefers err.status over err.response.status when both present', () => {
    // api-client wrapper may coexist with raw axios on the same throw
    const err = {
      status: 400,
      data: { message: 'bad request' },
      response: { status: 500, data: { message: 'from wrapped' } },
    };
    const out = extractApiError(err);
    expect(out.status).toBe(400);
    expect(out.message).toBe('Something went wrong. Please try again.');
  });

  it('infers code from data.error when it looks like a code (ALL_CAPS)', () => {
    const err = { status: 403, data: { error: 'COACH_AGREEMENT_OUTDATED' } };
    const out = extractApiError(err);
    expect(out.code).toBe('COACH_AGREEMENT_OUTDATED');
    expect(out.message).toMatch(/Something went wrong|COACH_AGREEMENT_OUTDATED/);
  });

  it('treats data.error as the message when it is a human sentence', () => {
    const err = { status: 400, data: { error: 'Please enter a valid email.' } };
    const out = extractApiError(err);
    expect(out.code).toBeNull();
    expect(out.message).toBe('Please enter a valid email.');
  });

  it('uses safe fallback when only an unapproved error message is available', () => {
    const err = new Error('Network request failed');
    const out = extractApiError(err);
    expect(out.status).toBeNull();
    expect(out.code).toBeNull();
    expect(out.message).toBe('Something went wrong. Please try again.');
  });

  it('falls back to the caller-provided default when nothing is available', () => {
    const out = extractApiError({}, 'Could not save profile.');
    expect(out.message).toBe('Could not save profile.');
  });

  it('never throws on null / undefined / non-object input', () => {
    expect(() => extractApiError(null)).not.toThrow();
    expect(() => extractApiError(undefined)).not.toThrow();
    expect(() => extractApiError('a string error')).not.toThrow();
    expect(() => extractApiError(42)).not.toThrow();
  });

  it('handles string data body (some endpoints return plain text)', () => {
    const err = { status: 500, data: 'Internal Server Error' };
    const out = extractApiError(err);
    expect(out.message).toBe('Something went wrong. Please try again.');
  });
});

describe('convenience helpers', () => {
  const err = {
    status: 429,
    data: { code: 'RATE_LIMIT', message: 'Too many requests.' },
  };

  it('apiErrorMessage returns just the message', () => {
    expect(apiErrorMessage(err)).toBe('Too many requests.');
  });

  it('apiErrorStatus returns just the status', () => {
    expect(apiErrorStatus(err)).toBe(429);
  });

  it('apiErrorCode returns just the code', () => {
    expect(apiErrorCode(err)).toBe('RATE_LIMIT');
  });

  it('convenience helpers are safe on null', () => {
    expect(apiErrorMessage(null)).toBeTruthy();
    expect(apiErrorStatus(null)).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
  });
});

it('never promotes untrusted API diagnostics into a display message', () => {
  const data = { code: 'UPLOAD_FAILED', message: 'PHPhotosErrorDomain private-value' };
  const out = extractApiError({ response: { status: 502, data } }, 'Upload failed.');
  expect(out.message).toBe('Upload failed.');
  expect(out.code).toBe('UPLOAD_FAILED');
  expect(out.status).toBe(502);
  expect(out.data).toBe(data);
});
