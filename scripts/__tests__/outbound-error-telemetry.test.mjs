import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as privacy from '../../shared/runtime/sentrySanitization.js';

test('Sentry final boundary excludes arbitrary diagnostics and request copies', () => {
  const raw = {
    event_id: '123',
    platform: 'javascript',
    message: 'private-value',
    request: { url: '/private-value' },
    extra: { raw: 'private-value' },
    contexts: { nested: { raw: 'private-value' } },
    breadcrumbs: [{ message: 'private-value' }],
    exception: {
      values: [
        {
          type: 'Error',
          value: 'private-value',
          stacktrace: {
            frames: [
              {
                filename: '/app/index.js?private-value',
                lineno: 42,
                vars: { raw: 'private-value' },
                pre_context: ['private-value'],
              },
            ],
          },
        },
      ],
    },
  };
  const safe = privacy.scrubErrorEvent(raw);
  assert.ok(!JSON.stringify(safe).includes('private-value'));
  assert.equal(safe.event_id, '123');
  assert.equal(safe.exception.values[0].stacktrace.frames[0].lineno, 42);
  assert.equal(raw.message, 'private-value');
});

test('PostHog automatic and explicit exceptions use the same final boundary', () => {
  const safe = privacy.scrubAnalyticsEvent({
    event: '$exception',
    properties: {
      distinct_id: 'user-id',
      $exception_list: [{ value: 'private-value' }],
      $exception_message: 'private-value',
      custom: { data: 'private-value' },
    },
  });
  assert.ok(!JSON.stringify(safe).includes('private-value'));
  assert.equal(safe.event, '$exception');
  assert.equal(privacy.scrubAnalyticsEvent(null), null);
});

test('analytics nesting fails closed, including cycles and deeply nested secrets', () => {
  const nested = { password: 'private-value' };
  nested.self = nested;
  const safe = privacy.scrubAnalyticsEvent({ event: 'clicked', properties: { nested } });
  assert.ok(!JSON.stringify(safe).includes('private-value'));
});

test('performance events cannot bypass the error send hook with captured payloads', () => {
  const safe = privacy.scrubTransactionEvent({
    type: 'transaction',
    transaction: '/private-value',
    start_timestamp: 1,
    timestamp: 2,
    contexts: {
      trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), data: 'private-value' },
    },
    spans: [
      {
        description: 'private-value',
        data: { token: 'private-value' },
        start_timestamp: 1,
        timestamp: 2,
      },
    ],
  });
  assert.ok(!JSON.stringify(safe).includes('private-value'));
  assert.equal(safe.type, 'transaction');
  assert.equal(safe.contexts.trace.trace_id, 'a'.repeat(32));
});
