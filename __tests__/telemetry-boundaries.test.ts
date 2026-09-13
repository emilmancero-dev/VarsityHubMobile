import * as Sentry from '@sentry/react-native';
import PostHog from 'posthog-react-native';
import { initSentry } from '@/utils/sentry';
import { initAnalytics } from '@/utils/analytics';

jest.mock('@sentry/react-native', () => ({ init: jest.fn(), setTag: jest.fn() }));
jest.mock('posthog-react-native', () =>
  jest.fn().mockImplementation(() => ({ register: jest.fn() }))
);
jest.mock('@/config/env', () => ({
  getConfig: () => ({ sentryDsn: 'https://example@o0.ingest.sentry.io/1', nodeEnv: 'production' }),
  getEnvValue: () => 'test-public-key',
}));

test('production SDK hooks scrub automatic errors before sending', () => {
  const testGlobal = globalThis as typeof globalThis & { __DEV__: boolean };
  const previous = testGlobal.__DEV__;
  testGlobal.__DEV__ = false;
  try {
    initSentry();
    initAnalytics();
    const sentryOptions = (Sentry.init as jest.Mock).mock.calls[0][0];
    const posthogOptions = (PostHog as unknown as jest.Mock).mock.calls[0][1];
    const sentryResult = sentryOptions.beforeSend(
      {
        exception: { values: [{ type: 'Error', value: 'private-value' }] },
        extra: { data: 'private-value' },
      },
      {}
    );
    const analyticsResult = posthogOptions.before_send({
      event: '$exception',
      properties: { $exception_message: 'private-value' },
    });
    expect(JSON.stringify(sentryResult)).not.toContain('private-value');
    expect(JSON.stringify(analyticsResult)).not.toContain('private-value');
  } finally {
    testGlobal.__DEV__ = previous;
  }
});
