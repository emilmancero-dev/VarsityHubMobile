import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as privacy from '../../shared/runtime/sentrySanitization.js';
import { PostHogCoreTestClient } from '@posthog/core/testing';

test('actual PostHog send hook preserves protocol timestamps without private diagnostics', async () => {
  const store = {};
  const bodies = [];
  const client = new PostHogCoreTestClient(
    {
      storage: {
        getItem: key => store[key],
        setItem: (key, value) => {
          store[key] = value;
        },
      },
      fetch: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return { status: 200, json: async () => ({}), text: async () => '' };
      },
    },
    'synthetic-public-key',
    {
      before_send: privacy.scrubAnalyticsEvent,
      preloadFeatureFlags: false,
      disableSurveys: true,
      disableCompression: true,
      flushInterval: 0,
      flushAt: 1000,
    }
  );
  const timestamp = new Date('2026-09-16T00:00:00Z');
  for (const event of ['Application Opened', '$exception']) {
    client.capture(
      event,
      { email: 'private-value', $exception_message: 'private-value' },
      {
        timestamp,
        uuid: '00000000-0000-4000-8000-000000000001',
      }
    );
  }
  await client.flush();
  const batch = bodies.flatMap(body => body.batch || []);
  assert.equal(batch.length, 2);
  assert.deepEqual(
    batch.map(item => item.event),
    ['Application Opened', '$exception']
  );
  for (const item of batch) {
    assert.equal(item.timestamp, timestamp.toISOString());
    assert.equal(item.uuid, '00000000-0000-4000-8000-000000000001');
  }
  assert.equal(batch[0].properties.email, '[redacted]');
  assert.ok(!JSON.stringify(batch[1]).includes('private-value'));
});

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
