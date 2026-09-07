import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const sentryMock = {
  init: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  withScope: jest.fn(),
};

const posthogCapture = jest.fn();
const posthogIdentify = jest.fn();
const posthogCreatePersonProfile = jest.fn();
const posthogSetPersonProperties = jest.fn();
const posthogReset = jest.fn();
const posthogScreen = jest.fn();
jest.mock('expo-updates', () => ({
  updateId: 'audit-ota',
  channel: 'production',
  runtimeVersion: '1.0.5',
}));

jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  default: sentryMock,
  ...sentryMock,
}));

jest.mock('posthog-react-native', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    capture: posthogCapture,
    captureException: posthogCapture,
    identify: posthogIdentify,
    createPersonProfile: posthogCreatePersonProfile,
    setPersonProperties: posthogSetPersonProperties,
    reset: posthogReset,
    screen: posthogScreen,
    register: jest.fn(),
  })),
}));

jest.mock('@/config/env', () => ({
  getConfig: () => ({
    sentryDsn: 'https://public@example.sentry.io/123',
    nodeEnv: 'production',
  }),
  getEnvValue: (key: string, fallback = '') => {
    if (key === 'EXPO_PUBLIC_POSTHOG_API_KEY') return 'phc_test_key';
    if (key === 'EXPO_PUBLIC_POSTHOG_HOST') return 'https://us.i.posthog.com';
    return fallback;
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '1.0.2',
      runtimeVersion: '1.0.2',
      sdkVersion: '52.0.0',
    },
  },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

describe('observability payload scrubbing', () => {
  beforeEach(() => {
    jest.resetModules();
    sentryMock.init.mockReset();
    sentryMock.setTag.mockReset();
    sentryMock.setUser.mockReset();
    sentryMock.captureException.mockReset();
    sentryMock.addBreadcrumb.mockReset();
    sentryMock.withScope.mockImplementation(((cb: (scope: any) => void) => {
      cb({
        setTag: jest.fn(),
        setContext: jest.fn(),
      });
    }) as any);
    posthogCapture.mockReset();
    posthogIdentify.mockReset();
    posthogCreatePersonProfile.mockReset();
    posthogSetPersonProperties.mockReset();
    posthogReset.mockReset();
    posthogScreen.mockReset();
    (global as any).__DEV__ = false;
  });

  const makeSentryAuthToken = () => `sntryu_${'a'.repeat(72)}`;

  it('redacts sensitive fields from Sentry exception context and tags', () => {
    const scope = {
      setTag: jest.fn(),
      setContext: jest.fn(),
    };
    sentryMock.withScope.mockImplementation(((cb: (currentScope: typeof scope) => void) =>
      cb(scope)) as any);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    expect(sentryMock.setTag).toHaveBeenCalledWith('ota_update_id', 'audit-ota');
    expect(sentryMock.setTag).toHaveBeenCalledWith('app_runtime', '1.0.5');
    sentry.captureException(new Error('boom'), {
      token: 'secret-token',
      nested: { email: 'coach@example.com', keep: 'ok' },
      tags: {
        route: '/organization',
        authorization: 'Bearer secret-token',
        context: 'coach_org_tools',
      },
    });

    expect(scope.setContext).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({
        token: '[redacted]',
        nested: expect.objectContaining({
          email: '[redacted]',
          keep: 'ok',
        }),
      })
    );
    expect(scope.setTag).toHaveBeenCalledWith('route', '/organization');
    expect(scope.setTag).toHaveBeenCalledWith('context', 'coach_org_tools');
    expect(scope.setTag).not.toHaveBeenCalledWith('authorization', expect.anything());
  });

  it('redacts token-like values even when the field name is not sensitive', () => {
    const scope = {
      setTag: jest.fn(),
      setContext: jest.fn(),
    };
    sentryMock.withScope.mockImplementation(((cb: (currentScope: typeof scope) => void) =>
      cb(scope)) as any);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    sentry.captureException(new Error('boom'), {
      diagnostics: `using ${makeSentryAuthToken()} for upload`,
      nested: {
        note: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      },
    });

    expect(scope.setContext).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({
        diagnostics: expect.stringContaining('[redacted]'),
        nested: expect.objectContaining({
          note: expect.stringContaining('[redacted]'),
        }),
      })
    );
    expect(scope.setContext).not.toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({
        diagnostics: expect.stringContaining('sntryu_'),
      })
    );
  });

  it('redacts token-like values from breadcrumb data payloads', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    sentry.captureBreadcrumb('upload check', 'build.sentry', {
      status: `using ${makeSentryAuthToken()}`,
      session: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    });

    expect(sentryMock.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: expect.stringContaining('[redacted]'),
          session: expect.stringContaining('[redacted]'),
        }),
      })
    );
  });

  it('redacts sensitive analytics properties before sending to PostHog', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const analyticsModule = require('@/utils/analytics') as typeof import('@/utils/analytics');

    analyticsModule.initAnalytics();
    analyticsModule.analytics.track('event_created', {
      token: 'secret-token',
      nested: { email: 'coach@example.com', keep: 'ok' },
      attendees: [{ phone: '5551234567' }, { keep: true }],
    });

    expect(posthogCapture).toHaveBeenCalledWith(
      'event_created',
      expect.objectContaining({
        token: '[redacted]',
      })
    );

    const payload = posthogCapture.mock.calls.find(([event]) => event === 'event_created')?.[1];
    expect(payload).toBeDefined();
    const properties = payload as Record<string, unknown>;
    expect(String(properties.nested)).toContain('"email":"[redacted]"');
    expect(String(properties.nested)).toContain('"keep":"ok"');
    expect(Array.isArray(properties.attendees)).toBe(true);
    expect(String((properties.attendees as unknown[])[0])).toContain('"phone":"[redacted]"');
  });

  it('drops transient client transport errors before sending to Sentry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    const initOptions = sentryMock.init.mock.calls[0]?.[0] as
      | { beforeSend?: (event: any, hint?: any) => any }
      | undefined;
    const beforeSend = initOptions?.beforeSend as ((event: any, hint?: any) => any) | undefined;

    expect(beforeSend).toEqual(expect.any(Function));
    const result = beforeSend?.(
      { exception: { values: [{ value: 'Cannot connect to server' }] }, tags: {} },
      {
        originalException: {
          message: 'Cannot connect to server at https://api.example.com',
          isNetworkError: true,
          status: 0,
        },
      }
    );
    expect(result).toBeNull();
  });

  it('drops expected auth UX errors for auth flow contexts', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    const initOptions = sentryMock.init.mock.calls[0]?.[0] as
      | { beforeSend?: (event: any, hint?: any) => any }
      | undefined;
    const beforeSend = initOptions?.beforeSend as ((event: any, hint?: any) => any) | undefined;

    expect(beforeSend).toEqual(expect.any(Function));
    const result = beforeSend?.(
      {
        exception: { values: [{ value: 'Invalid email or password. Please try again.' }] },
        tags: { context: 'email-password-login' },
      },
      {
        originalException: { message: 'Invalid email or password. Please try again.', status: 401 },
      }
    );
    expect(result).toBeNull();
  });

  it('does not send expected auth UX errors to Sentry or analytics exception capture', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sentry = require('@/utils/sentry') as typeof import('@/utils/sentry');

    sentry.initSentry();
    sentry.captureException(
      Object.assign(new Error('Token already used'), {
        status: 400,
        data: { error: 'TOKEN_ALREADY_USED' },
      }),
      { tags: { context: 'password_reset_submit' } }
    );

    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(posthogCapture).not.toHaveBeenCalled();
  });
});
