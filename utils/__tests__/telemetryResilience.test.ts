const mockPosthog = {
  register: jest.fn(),
  capture: jest.fn(),
  captureException: jest.fn(),
  identify: jest.fn(),
  createPersonProfile: jest.fn(),
  setPersonProperties: jest.fn(),
  reset: jest.fn(),
  screen: jest.fn(),
  getSessionId: jest.fn(() => 'session-test'),
};
const mockScope = { setTag: jest.fn(), setContext: jest.fn(), setFingerprint: jest.fn() };
const mockSentry = {
  init: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  withScope: jest.fn((fn: any) => fn(mockScope)),
  captureException: jest.fn(() => 'sentry-event-test'),
};
jest.mock('posthog-react-native', () => ({
  __esModule: true,
  default: jest.fn(() => mockPosthog),
}));
jest.mock('@sentry/react-native', () => mockSentry);
jest.mock('@/config/env', () => ({
  getConfig: () => ({ sentryDsn: 'https://test@o1.ingest.sentry.io/1', nodeEnv: 'production' }),
  getEnvValue: (key: string, fallback: string) =>
    key === 'EXPO_PUBLIC_POSTHOG_API_KEY' ? 'phc_test' : fallback,
}));

describe('telemetry failure isolation', () => {
  const originalDev = __DEV__;
  let sentry: typeof import('../sentry');
  let analytics: typeof import('../analytics');
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSentry.captureException.mockReset().mockReturnValue('sentry-event-test');
    mockSentry.addBreadcrumb.mockReset();
    mockSentry.init.mockReset();
    Object.values(mockPosthog).forEach(fn => fn.mockReset());
    mockPosthog.getSessionId.mockReturnValue('session-test');
    (global as any).__DEV__ = false;
    sentry = require('../sentry');
    analytics = require('../analytics');
    sentry.initSentry();
    analytics.initAnalytics();
  });
  afterEach(() => {
    (global as any).__DEV__ = originalDev;
  });

  it('still sends the original error to Sentry when PostHog throws', () => {
    mockPosthog.captureException.mockImplementation(() => {
      throw new Error('PostHog failed');
    });
    const error = new Error('Actual purchase failure');
    expect(() =>
      sentry.captureException(error, { tags: { context: 'ad_receipt_recovery' } })
    ).not.toThrow();
    expect(mockSentry.captureException).toHaveBeenCalledWith(error);
  });

  it('links a mirrored exception to its Sentry event and PostHog session', () => {
    const error = new Error('Marker update failed');
    sentry.captureException(error);
    expect(mockScope.setTag).toHaveBeenCalledWith('posthog_session_id', 'session-test');
    expect(mockPosthog.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ sentry_event_id: 'sentry-event-test' })
    );
  });

  it('does not throw product actions when analytics capture fails, and reports once per operation', () => {
    mockPosthog.capture.mockImplementation(() => {
      throw new Error('Storage failure');
    });
    mockSentry.captureException.mockClear();
    expect(() => analytics.analytics.track('post_created')).not.toThrow();
    expect(() => analytics.analytics.track('post_created')).not.toThrow();
    expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        fingerprint: ['telemetry_sdk_failure', 'posthog', 'track'],
      })
    );
  });

  it('catches rejected screen promises without creating an unhandled rejection', async () => {
    mockPosthog.screen.mockRejectedValue(new Error('Async storage failure'));
    analytics.analytics.screen('map');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        fingerprint: ['telemetry_sdk_failure', 'posthog', 'screen'],
      })
    );
  });

  it('still mirrors the original exception when Sentry capture throws', () => {
    mockSentry.captureException.mockImplementation(() => {
      throw new Error('Sentry failed');
    });
    const error = new Error('Original error');
    expect(() => sentry.captureException(error)).not.toThrow();
    expect(mockPosthog.captureException).toHaveBeenCalledWith(error, expect.any(Object));
  });

  it('does not break a map update when breadcrumb recording fails', () => {
    mockSentry.addBreadcrumb.mockImplementation(() => {
      throw new Error('Native bridge unavailable');
    });
    expect(() => sentry.captureBreadcrumb('Map mounted', 'map.lifecycle')).not.toThrow();
  });

  it('never drops a fatal event because its text resembles a business outcome', () => {
    const beforeSend = mockSentry.init.mock.calls[0][0].beforeSend;
    const event = {
      level: 'fatal',
      exception: { values: [{ value: 'LOCATION_REQUIRED native assertion' }] },
    };
    expect(beforeSend(event, {})).toBe(event);
  });
});
