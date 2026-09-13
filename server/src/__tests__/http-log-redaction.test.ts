import {
  redactSensitiveHeaders,
  redactSerializedRequest,
  redactUrlTokens,
} from '../lib/httpLogRedaction.js';

describe('HTTP log redaction', () => {
  it('redacts token query params while preserving route shape', () => {
    expect(redactUrlTokens('/auth/reset?token=abc123&next=/settings')).toBe(
      '/auth/reset?token=[redacted]&next=/settings'
    );
    expect(redactUrlTokens('/oauth/callback?access_token=secret#done')).toBe(
      '/oauth/callback?access_token=[redacted]#done'
    );
  });

  it('redacts sensitive request headers case-insensitively', () => {
    expect(
      redactSensitiveHeaders({
        authorization: 'Bearer token',
        'X-Health-Check-Secret': 'health-secret',
        'stripe-signature': 'stripe-signature',
        'x-idempotency-key': 'idempotency-key',
        'x-sendgrid-event-webhook-signature': 'sendgrid-signature',
        accept: 'application/json',
      })
    ).toEqual({
      authorization: '[redacted]',
      'X-Health-Check-Secret': '[redacted]',
      'stripe-signature': '[redacted]',
      'x-idempotency-key': '[redacted]',
      'x-sendgrid-event-webhook-signature': '[redacted]',
      accept: 'application/json',
    });
  });

  it('redacts serialized pino request objects in one pass', () => {
    expect(
      redactSerializedRequest({
        url: '/health/email?token=keep-out',
        headers: {
          'x-health-check-secret': 'secret',
          cookie: 'sid=secret',
          accept: '*/*',
        },
      })
    ).toEqual({
      url: '/health/email?token=[redacted]',
      headers: {
        'x-health-check-secret': '[redacted]',
        cookie: '[redacted]',
        accept: '*/*',
      },
    });
  });
});

it('redacts additional credential names in request URLs and headers', () => {
  const result = redactSerializedRequest({
    url: '/callback?api_key=private-value&csrf_token=private-value&password=private-value',
    headers: { 'X-Api-Key': 'private-value', 'X-Client-Secret': 'private-value' },
  });
  expect(JSON.stringify(result)).not.toContain('private-value');
});
