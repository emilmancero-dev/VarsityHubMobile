import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const scope = {
  setTag: jest.fn(),
  setContext: jest.fn(),
};

const withScopeMock = jest.fn((callback: (scope: typeof scope) => void) => callback(scope));
const captureExceptionMock = jest.fn();
const captureMessageMock = jest.fn();
const initMock = jest.fn();

jest.unstable_mockModule('@sentry/node', () => ({
  init: initMock,
  withScope: withScopeMock,
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  configureScope: jest.fn(),
  Handlers: {
    requestHandler: jest.fn(() => jest.fn()),
    tracingHandler: jest.fn(() => jest.fn()),
    errorHandler: jest.fn(() => jest.fn()),
  },
  Integrations: {
    Http: class {},
    OnUncaughtException: class {},
    OnUnhandledRejection: class {},
  },
}));

const { captureException, captureMessage, initSentry } = await import('../lib/sentry.js');

function initAndGetBeforeSend(nodeEnv: string): (event: any) => any {
  const prevDsn = process.env.SENTRY_DSN;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.SENTRY_DSN = 'https://key@example.ingest.sentry.io/1';
  process.env.NODE_ENV = nodeEnv;
  try {
    initMock.mockClear();
    const app = { use: jest.fn() } as any;
    initSentry(app);
    const options = initMock.mock.calls[0]?.[0] as { beforeSend: (event: any) => any };
    return options.beforeSend;
  } finally {
    process.env.SENTRY_DSN = prevDsn;
    process.env.NODE_ENV = prevNodeEnv;
  }
}

describe('Sentry scope tagging', () => {
  beforeEach(() => {
    scope.setTag.mockClear();
    scope.setContext.mockClear();
    withScopeMock.mockClear();
    captureExceptionMock.mockClear();
    captureMessageMock.mockClear();
  });

  it('promotes nested extra.context metadata into searchable tags for exceptions', () => {
    captureException(new Error('queue blew up'), {
      extra: {
        context: 'queue_cleanup',
        path: '/admin/coaches/cmpsnx0jt001310ulizn8xxez/approve',
        job: 'cleanup-old-notifications',
        provider: 'sendgrid',
      },
    });

    expect(scope.setTag).toHaveBeenCalledWith('service', 'server');
    expect(scope.setTag).toHaveBeenCalledWith('vh_context', 'queue_cleanup');
    expect(scope.setTag).toHaveBeenCalledWith('route', '/admin/coaches/:id/approve');
    expect(scope.setTag).toHaveBeenCalledWith('job', 'cleanup-old-notifications');
    expect(scope.setTag).toHaveBeenCalledWith('provider', 'sendgrid');
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
  });

  it('keeps explicit top-level context authoritative over nested extra context', () => {
    captureMessage('manual warning', 'warning', {
      context: 'top_level_context',
      route: '/payments/webhook',
      extra: {
        context: 'nested_context',
        route: '/payments/not-used',
        provider: 'stripe',
      },
    });

    expect(scope.setTag).toHaveBeenCalledWith('vh_context', 'top_level_context');
    expect(scope.setTag).toHaveBeenCalledWith('route', '/payments/webhook');
    expect(scope.setTag).toHaveBeenCalledWith('provider', 'stripe');
    expect(captureMessageMock).toHaveBeenCalledWith('manual warning', 'warning');
  });
});

describe('Sentry beforeSend environment filter', () => {
  it('drops every event when the environment is development', () => {
    const beforeSend = initAndGetBeforeSend('development');
    const event = { exception: { values: [{ type: 'Error', value: 'placeholder Stripe key' }] } };
    expect(beforeSend(event)).toBeNull();
  });

  it('keeps ordinary error events in production', () => {
    const beforeSend = initAndGetBeforeSend('production');
    const event = { exception: { values: [{ type: 'Error', value: 'real failure' }] } };
    const result = beforeSend(event);
    expect(result.exception.values[0].type).toBe('Error');
    expect(JSON.stringify(result)).not.toContain('real failure');
    expect(event.exception.values[0].value).toBe('real failure');
  });

  it('still drops health-check noise in production', () => {
    const beforeSend = initAndGetBeforeSend('production');
    expect(beforeSend({ request: { url: 'https://api.example.com/health' } })).toBeNull();
  });
});
