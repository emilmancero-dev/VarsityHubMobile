export const SENSITIVE_SENTRY_KEY_RE: RegExp;
export const MAX_SENTRY_VALUE_LENGTH: number;

export function normalizeSentryValue(value: unknown): string;
export function normalizeSentryBreadcrumbData(
  data?: Record<string, any>
): Record<string, string> | undefined;

export function scrubErrorEvent<T>(event: T): T;
export function sanitizeTelemetryData<T>(value: T): T;
export function scrubAnalyticsEvent<T>(event: T): T;
export function scrubTransactionEvent<T>(event: T): T;
