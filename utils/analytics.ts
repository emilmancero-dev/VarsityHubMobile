/**
 * PostHog Analytics — centralized event tracking
 *
 * Usage:
 *   import { analytics } from '@/utils/analytics';
 *   analytics.track('post_created', { type: 'text' });
 *   analytics.identify(userId, { role: 'coach', plan: 'veteran' });
 */

import PostHog from 'posthog-react-native';
import * as Sentry from '@sentry/react-native';
import * as env from '@/config/env';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

const readAnalyticsEnv = (
  key: 'EXPO_PUBLIC_POSTHOG_API_KEY' | 'EXPO_PUBLIC_POSTHOG_HOST',
  fallback = ''
) => (typeof env.getEnvValue === 'function' ? env.getEnvValue(key, fallback) : fallback);

const POSTHOG_API_KEY = readAnalyticsEnv('EXPO_PUBLIC_POSTHOG_API_KEY');
const POSTHOG_HOST = readAnalyticsEnv('EXPO_PUBLIC_POSTHOG_HOST', 'https://us.i.posthog.com');
const APP_VERSION = Constants.expoConfig?.version || 'unknown';
const APP_RUNTIME =
  Updates.runtimeVersion || String(Constants.expoConfig?.runtimeVersion || APP_VERSION);
const SENSITIVE_ANALYTICS_KEY_RE = /password|secret|token|authorization|cookie|email|phone|code/i;
const MAX_ANALYTICS_STRING_LENGTH = 160;
const MAX_ANALYTICS_DEPTH = 3;
const MAX_ANALYTICS_ARRAY_ITEMS = 10;
const MAX_ANALYTICS_KEYS = 25;

let posthog: PostHog | null = null;
let analyticsInitialized = false;

const isDevelopmentRuntime = () =>
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ === true;

function normalizeAnalyticsValue(value: unknown, depth = 0): string | number | boolean | string[] {
  if (value == null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_ANALYTICS_STRING_LENGTH) {
      return `${value.slice(0, MAX_ANALYTICS_STRING_LENGTH)}...`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ANALYTICS_ARRAY_ITEMS).map(item => {
      if (item == null) return 'null';
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return String(item);
      }
      if (depth >= MAX_ANALYTICS_DEPTH) {
        try {
          return JSON.stringify(item);
        } catch {
          return '[unserializable]';
        }
      }
      try {
        return JSON.stringify(sanitizeAnalyticsObject(item, depth + 1));
      } catch {
        return '[unserializable]';
      }
    });
  }
  try {
    return JSON.stringify(sanitizeAnalyticsObject(value, depth + 1));
  } catch {
    return '[unserializable]';
  }
}

function sanitizeAnalyticsObject(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'non-finite';
  if (typeof value === 'string') {
    return value.length > MAX_ANALYTICS_STRING_LENGTH
      ? `${value.slice(0, MAX_ANALYTICS_STRING_LENGTH)}...`
      : value;
  }
  if (depth >= MAX_ANALYTICS_DEPTH) {
    return normalizeAnalyticsValue(value, depth);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ANALYTICS_ARRAY_ITEMS)
      .map(item => sanitizeAnalyticsObject(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_ANALYTICS_KEYS)
        .filter(([, nestedValue]) => typeof nestedValue !== 'undefined')
        .map(([key, nestedValue]) => [
          key,
          SENSITIVE_ANALYTICS_KEY_RE.test(key)
            ? '[redacted]'
            : sanitizeAnalyticsObject(nestedValue, depth + 1),
        ])
    );
  }
  return String(value);
}

function normalizeAnalyticsProperties(
  properties?: Record<string, unknown>
): Record<string, string | number | boolean | string[]> | undefined {
  return properties
    ? Object.fromEntries(
        Object.entries(properties)
          .slice(0, MAX_ANALYTICS_KEYS)
          .filter(([, value]) => typeof value !== 'undefined')
          .map(([key, value]) => [
            key,
            SENSITIVE_ANALYTICS_KEY_RE.test(key) ? '[redacted]' : normalizeAnalyticsValue(value),
          ])
      )
    : undefined;
}

// SDK/storage failures must not break the product action or the other reporter.
// Report once per operation per runtime to avoid recursively flooding telemetry.
const reportedFailures = new Set<string>();
function reportAnalyticsFailure(operation: string, error: unknown) {
  if (reportedFailures.has(operation)) return;
  reportedFailures.add(operation);
  try {
    // Deliberately use the SDK directly: utils/sentry mirrors to PostHog.
    Sentry.captureException(error, {
      tags: {
        service: 'mobile',
        context: 'telemetry_sdk_failure',
        telemetry_provider: 'posthog',
        telemetry_operation: operation,
      },
      fingerprint: ['telemetry_sdk_failure', 'posthog', operation],
    });
  } catch {
    console.warn('[telemetry] Both error reporters failed');
  }
}
function runAnalytics(operation: string, action: () => unknown) {
  try {
    void Promise.resolve(action()).catch(error => reportAnalyticsFailure(operation, error));
  } catch (error) {
    reportAnalyticsFailure(operation, error);
  }
}

export function getAnalyticsSessionId(): string | undefined {
  try {
    return posthog?.getSessionId();
  } catch (error) {
    reportAnalyticsFailure('session', error);
    return undefined;
  }
}

export function initAnalytics(readiness?: { sentry_ready: boolean }) {
  if (analyticsInitialized || isDevelopmentRuntime() || !POSTHOG_API_KEY) return;
  runAnalytics('initialize', () => {
    const client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      enableSessionReplay: false,
      errorTracking: { autocapture: { uncaughtExceptions: true, unhandledRejections: true } },
    });
    client.register({
      service: 'mobile',
      platform: Platform.OS,
      app_version: APP_VERSION,
      app_runtime: APP_RUNTIME,
      ota_update_id: Updates.updateId || 'embedded',
      ota_channel: Updates.channel || 'unknown',
    });
    posthog = client;
    analyticsInitialized = true;
    analytics.track('telemetry_initialized', readiness);
  });
}

export function captureAnalyticsException(
  error: Error | unknown,
  properties?: Record<string, unknown>
) {
  runAnalytics('exception', () =>
    posthog?.captureException(error, normalizeAnalyticsProperties(properties))
  );
}

export const analytics = {
  track: (event: string, properties?: Record<string, any>) => {
    runAnalytics('track', () => posthog?.capture(event, normalizeAnalyticsProperties(properties)));
  },
  identify: (userId: string, properties?: Record<string, any>) => {
    runAnalytics('identify', () => {
      if (!posthog) return;
      const safeProperties = normalizeAnalyticsProperties(properties);
      posthog.identify(userId, safeProperties);
      posthog.createPersonProfile();
      if (safeProperties && Object.keys(safeProperties).length > 0) {
        posthog.setPersonProperties(safeProperties, { first_seen_app_version: APP_VERSION }, false);
      }
    });
  },
  reset: () => {
    runAnalytics('reset', () => posthog?.reset());
  },
  screen: (screenName: string, properties?: Record<string, any>) => {
    runAnalytics('screen', () =>
      posthog?.screen(screenName, normalizeAnalyticsProperties(properties))
    );
  },
};

// Event name constants for type safety
export const ANALYTICS_EVENTS = {
  USER_SIGNED_UP: 'user_signed_up',
  USER_SIGNED_IN: 'user_signed_in',
  PASSWORD_RESET_CODE_REQUESTED: 'password_reset_code_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',
  POST_CREATED: 'post_created',
  POST_UPVOTED: 'post_upvoted',
  COMMENT_CREATED: 'comment_created',
  EVENT_PAGE_VIEWED: 'event_page_viewed',
  STORY_ADDED: 'story_added',
  POLL_VOTED: 'poll_voted',
  AD_SUBMITTED: 'ad_submitted',
  AD_PAYMENT_COMPLETED: 'ad_payment_completed',
  COACH_APPROVAL_REQUESTED: 'coach_approval_requested',
  COACH_APPROVED: 'coach_approved',
  GEOFENCE_BLOCKED: 'geofence_blocked',
  SEARCH_PERFORMED: 'search_performed',
  PROFILE_EDITED: 'profile_edited',
  COACH_QUICK_ACTION_TAPPED: 'coach_quick_action_tapped',
} as const;
