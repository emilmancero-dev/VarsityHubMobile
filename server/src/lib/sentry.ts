import {
  scrubErrorEvent,
  scrubTransactionEvent,
} from '@varsityhub/shared/runtime/sentrySanitization';
import * as Sentry from '@sentry/node';
import { normalizeSentryBreadcrumbData } from '@varsityhub/shared/runtime/sentrySanitization';
import type { Express, Request } from 'express';
import crypto from 'node:crypto';
import { debugLog } from './debugLog.js';

const SERVER_SERVICE_TAG = 'server';

/** Check-ins bypass beforeSend, so gate them explicitly and isolate SDK failures. */
export function captureSchedulerCheckIn(
  checkIn: Parameters<typeof Sentry.captureCheckIn>[0],
  config?: Parameters<typeof Sentry.captureCheckIn>[1]
): string | undefined {
  if (process.env.NODE_ENV !== 'production' || !process.env.SENTRY_DSN) return;
  try {
    return Sentry.captureCheckIn(checkIn, config);
  } catch {
    console.warn('[Scheduler] Sentry check-in could not be queued');
    return undefined;
  }
}

// Strip ID-like path segments so `route` stays low-cardinality enough to
// alert on. /posts/cmod7xy123 -> /posts/:id, /games/42 -> /games/:id.
// Without this, every unique resource ID becomes a distinct tag value and
// alerts like `route:/posts/:id` never match the stored value.
const ID_LIKE_SEGMENT_RE =
  /^(c[a-z0-9]{20,}|[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|\d{3,})$/i;

function normalizeRoutePath(path: string): string {
  if (!path || path === '/') return path;
  return path
    .split('/')
    .map(seg => (ID_LIKE_SEGMENT_RE.test(seg) ? ':id' : seg))
    .join('/');
}

export function getSentryRouteTag(req: Request): string {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
  if (routePath) {
    return normalizeRoutePath(`${req.baseUrl || ''}${routePath}`);
  }
  if (req.baseUrl) {
    return normalizeRoutePath(req.baseUrl);
  }
  return normalizeRoutePath(req.path);
}

const PROVIDER_TAG_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\bcloudinary\b/i, provider: 'cloudinary' },
  { pattern: /\bsendgrid\b|\bemail\b/i, provider: 'sendgrid' },
  { pattern: /\bbullmq\b|\bredis\b/i, provider: 'bullmq' },
  { pattern: /\bstripe\b/i, provider: 'stripe' },
  { pattern: /\bapple(?:[_-]|\s)?(?:iap|s2s)?\b/i, provider: 'apple_iap' },
  { pattern: /\bgoogle(?:[_-]|\s)?iap\b/i, provider: 'google_iap' },
];

// Redact `token`/`access_token` query params from a query string or URL,
// replacing only the value with [redacted] so the shape (which param was
// present) is preserved for debugging. Anchored to a delimiter (start, ?, &,
// #) so we never partially match unrelated params like `csrf_token`.
const TOKEN_QUERY_PARAM_RE = /(^|[?&#])(access_token|token)=[^&#\s]*/gi;

export function redactTokenQueryParams(input: string): string {
  return input.replace(TOKEN_QUERY_PARAM_RE, (_match, prefix, key) => `${prefix}${key}=[redacted]`);
}

/**
 * Defense-in-depth scrub of request data on a Sentry event. Even with the
 * requestHandler configured not to attach bodies/cookies/headers, this strips
 * anything that slips in from another capture path: cookies, Authorization /
 * Cookie headers, the request body, and token query params in url/query_string.
 * Mirrors the client's SENSITIVE_VALUE_RE / normalizeSentryBreadcrumbData intent
 * (utils/sentry.ts) for the request envelope specifically.
 */
export function scrubSentryRequestData<T extends { request?: any }>(event: T): T {
  const request = event?.request;
  if (!request || typeof request !== 'object') {
    return event;
  }

  // Never send cookies.
  delete request.cookies;

  // Strip sensitive headers regardless of casing.
  const headers = request.headers;
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (
        /authorization|cookie|stripe-signature|x-health-check-secret|x-idempotency-key|x-sendgrid-event-webhook/i.test(
          key
        )
      ) {
        delete headers[key];
      }
    }
  }

  // Never send request bodies — /auth routes carry plaintext passwords/emails.
  request.data = undefined;

  // Redact token/access_token values from the URL and query string.
  if (typeof request.query_string === 'string') {
    request.query_string = redactTokenQueryParams(request.query_string);
  }
  if (typeof request.url === 'string') {
    request.url = redactTokenQueryParams(request.url);
  }

  return event;
}

/**
 * Initialize Sentry error tracking
 */
export function initSentry(app: Express) {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.NODE_ENV || 'development';

  if (!dsn) {
    debugLog('⚠️ Sentry DSN not configured - error tracking disabled');
    return;
  }

  const release =
    process.env.SENTRY_RELEASE?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined;

  Sentry.init({
    dsn,
    environment,
    release,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.OnUncaughtException(),
      new Sentry.Integrations.OnUnhandledRejection(),
    ],
    // Performance Monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    maxBreadcrumbs: 50,
    attachStacktrace: true,
    // Drop malformed-URL decode errors from internet scanners (e.g. bots
    // probing /%c0%2eenv with invalid percent-encoding). These are client
    // errors handled as 400 by errorHandler; this is defense-in-depth so they
    // never reach Sentry even if captured elsewhere.
    ignoreErrors: [/Failed to decode param/, 'URIError'],
    beforeSendTransaction: scrubTransactionEvent,
    beforeSend(event: any) {
      // Drop everything from dev machines. Local runs (e.g. the
      // stripe-webhook-reconciliation cron with placeholder Stripe keys) share
      // the prod Sentry project and were flooding it with non-actionable
      // errors. Mirrors the mobile client's __DEV__ drop in utils/sentry.ts.
      if (environment === 'development') {
        return null;
      }
      // Filter out health checks and non-error requests
      if (event.request?.url?.includes('/health')) {
        return null;
      }
      // Belt-and-suspenders: drop any malformed-URL decode error by message.
      const values = event.exception?.values;
      if (Array.isArray(values)) {
        for (const v of values) {
          if (v?.type === 'URIError' || /Failed to decode param/.test(String(v?.value || ''))) {
            return null;
          }
        }
      }
      // Defense-in-depth: scrub any request data (bodies, cookies, auth
      // headers, token query params) that slipped in before shipping.
      return scrubErrorEvent(scrubSentryRequestData(event));
    },
  });

  // Request handler - should be the first middleware. Do NOT attach request
  // bodies (plaintext passwords/emails on /auth routes), cookies, headers
  // (Authorization: Bearer <JWT>), or the client IP. Keep only method, url,
  // and query_string. The `include.request` array is the typed way to express
  // this in @sentry/node 7 (the top-level cookies/data/headers booleans the
  // task sketched are not part of AddRequestDataToEventOptions).
  app.use(
    Sentry.Handlers.requestHandler({
      include: { request: ['method', 'url', 'query_string'], ip: false },
    })
  );

  // Tracing middleware
  app.use(Sentry.Handlers.tracingHandler());

  app.use((req, _res, next) => {
    Sentry.configureScope(scope => {
      scope.setTag('service', SERVER_SERVICE_TAG);
      scope.setTag('route', getSentryRouteTag(req));
      scope.setTag('method', req.method);
    });
    next();
  });

  Sentry.configureScope(scope => {
    scope.setTag('service', SERVER_SERVICE_TAG);
  });

  debugLog(`✅ Sentry initialized for ${environment} environment`);
}

/**
 * Add error handler middleware (should be last)
 */
export function addSentryErrorHandler(app: Express) {
  app.use(Sentry.Handlers.errorHandler());
}

/**
 * Manually capture exception
 */
export function captureException(error: Error | string, context?: Record<string, any>) {
  Sentry.withScope(scope => {
    scope.setTag('service', SERVER_SERVICE_TAG);
    if (context) {
      applyScopeTags(scope, context);
      scope.setContext('additional', context);
    }
    if (typeof error === 'string') {
      Sentry.captureMessage(error, 'error');
    } else {
      Sentry.captureException(error);
    }
  });
}

/**
 * Manually capture message
 */
export function captureMessage(
  message: string,
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info',
  context?: Record<string, any>
) {
  Sentry.withScope(scope => {
    scope.setTag('service', SERVER_SERVICE_TAG);
    if (context) {
      applyScopeTags(scope, context);
      scope.setContext('additional', context);
    }
    Sentry.captureMessage(message, level);
  });
}

/**
 * Set user context for error tracking
 */
export function setUserContext(userId: string, email?: string, username?: string) {
  const hashedUserId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  Sentry.setUser({
    id: `u_${hashedUserId}`,
  });
}

/**
 * Clear user context
 */
export function clearUserContext() {
  Sentry.setUser(null);
}

function getNestedExtraContext(context: Record<string, any>): Record<string, any> | null {
  const extra = context.extra;
  return extra && typeof extra === 'object' && !Array.isArray(extra)
    ? (extra as Record<string, any>)
    : null;
}

function getContextValue(context: Record<string, any>, key: string): unknown {
  if (typeof context[key] !== 'undefined') return context[key];
  const extra = getNestedExtraContext(context);
  return extra ? extra[key] : undefined;
}

function applyScopeTags(scope: Sentry.Scope, context: Record<string, any>) {
  scope.setTag('service', SERVER_SERVICE_TAG);

  const explicitContextTag =
    typeof getContextValue(context, 'context') === 'string'
      ? (getContextValue(context, 'context') as string)
      : typeof context.tags?.context === 'string'
        ? context.tags.context
        : null;
  const contextTag = explicitContextTag?.trim() || null;
  if (contextTag) {
    scope.setTag('vh_context', contextTag);
  }

  const routeValue =
    typeof getContextValue(context, 'path') === 'string'
      ? getContextValue(context, 'path')
      : typeof getContextValue(context, 'route') === 'string'
        ? getContextValue(context, 'route')
        : null;
  const route = typeof routeValue === 'string' ? routeValue : null;
  if (route && !context.tags?.route) {
    scope.setTag('route', normalizeRoutePath(route));
  }

  const jobValue =
    typeof getContextValue(context, 'job') === 'string'
      ? getContextValue(context, 'job')
      : typeof getContextValue(context, 'jobName') === 'string'
        ? getContextValue(context, 'jobName')
        : null;
  const job = typeof jobValue === 'string' ? jobValue : null;
  if (job && !context.tags?.job) {
    scope.setTag('job', job);
  }

  const provider = inferProviderTag(context, contextTag);
  if (provider && !context.tags?.provider) {
    scope.setTag('provider', provider);
  }

  const tags = context.tags;
  if (tags && typeof tags === 'object') {
    for (const [key, value] of Object.entries(tags)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        scope.setTag(key, String(value));
      }
    }
  }
}

function inferProviderTag(context: Record<string, any>, contextTag?: string | null): string | null {
  const extra = getNestedExtraContext(context);
  const candidates = [
    contextTag,
    typeof getContextValue(context, 'provider') === 'string'
      ? (getContextValue(context, 'provider') as string)
      : null,
    typeof getContextValue(context, 'label') === 'string'
      ? (getContextValue(context, 'label') as string)
      : null,
    typeof getContextValue(context, 'message') === 'string'
      ? (getContextValue(context, 'message') as string)
      : null,
    typeof extra?.message === 'string' ? extra.message : null,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    for (const rule of PROVIDER_TAG_PATTERNS) {
      if (rule.pattern.test(candidate)) {
        return rule.provider;
      }
    }
  }

  return null;
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(
  message: string,
  category: string = 'custom',
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info',
  data?: Record<string, any>
) {
  Sentry.addBreadcrumb({
    message,
    category,
    level,
    data: normalizeSentryBreadcrumbData(data),
  });
}
