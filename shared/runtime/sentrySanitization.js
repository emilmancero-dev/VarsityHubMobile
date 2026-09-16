export const SENSITIVE_SENTRY_KEY_RE =
  /password|secret|token|authorization|cookie|email|phone|code/i;
export const MAX_SENTRY_VALUE_LENGTH = 160;

export function normalizeSentryValue(value, depth = 0) {
  if (depth >= 5) return '[omitted]';
  if (value == null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'non-finite';
  if (typeof value === 'string') {
    return value.length > MAX_SENTRY_VALUE_LENGTH
      ? `${value.slice(0, MAX_SENTRY_VALUE_LENGTH)}...`
      : value;
  }
  if (Array.isArray(value)) {
    return `[${value
      .slice(0, 5)
      .map(item => normalizeSentryValue(item, depth + 1))
      .join(', ')}${value.length > 5 ? ', ...' : ''}]`;
  }
  try {
    const serialized = JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .slice(0, 20)
          .map(([key, item]) => [
            key,
            SENSITIVE_SENTRY_KEY_RE.test(key)
              ? '[redacted]'
              : normalizeSentryValue(item, depth + 1),
          ])
      )
    );
    if (!serialized) return 'empty-object';
    return serialized.length > MAX_SENTRY_VALUE_LENGTH
      ? `${serialized.slice(0, MAX_SENTRY_VALUE_LENGTH)}...`
      : serialized;
  } catch {
    return '[unserializable]';
  }
}

export function normalizeSentryBreadcrumbData(data) {
  if (!data) return undefined;

  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'undefined') continue;
    normalized[key] = SENSITIVE_SENTRY_KEY_RE.test(key)
      ? '[redacted]'
      : normalizeSentryValue(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// Final SDK boundary: exception messages and arbitrary context are not a safe
// diagnostic schema. Keep source locations for grouping, never captured values.
function safeFrames(stacktrace) {
  if (!Array.isArray(stacktrace?.frames)) return undefined;
  return {
    frames: stacktrace.frames.slice(-100).map(frame => ({
      filename:
        typeof frame?.filename === 'string'
          ? frame.filename.split(/[?#]/)[0].split(/[\\/]/).pop().slice(0, 120)
          : undefined,
      lineno: Number.isInteger(frame?.lineno) ? frame.lineno : undefined,
      colno: Number.isInteger(frame?.colno) ? frame.colno : undefined,
      in_app: frame?.in_app === true,
    })),
  };
}

export function scrubErrorEvent(event) {
  const safe = {};
  for (const key of [
    'event_id',
    'timestamp',
    'platform',
    'release',
    'dist',
    'environment',
    'level',
    'sdk',
    'debug_meta',
  ]) {
    if (event?.[key] !== undefined) safe[key] = event[key];
  }
  if (event?.exception?.values) {
    safe.exception = {
      values: event.exception.values.slice(0, 5).map(value => ({
        type: [
          'Error',
          'TypeError',
          'RangeError',
          'ReferenceError',
          'SyntaxError',
          'URIError',
        ].includes(value?.type)
          ? value.type
          : 'Error',
        value: 'Application error; diagnostic text omitted',
        stacktrace: safeFrames(value?.stacktrace),
      })),
    };
  } else {
    safe.message = 'Application event; diagnostic text omitted';
  }
  return safe;
}

export function sanitizeTelemetryData(value, depth = 0) {
  if (depth >= 5) return '[omitted]';
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string')
    return value.replace(/Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted]').slice(0, 160);
  if (Array.isArray(value))
    return value.slice(0, 20).map(item => sanitizeTelemetryData(item, depth + 1));
  if (typeof value !== 'object') return '[omitted]';
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, item]) => [
        key,
        SENSITIVE_SENTRY_KEY_RE.test(key) ? '[redacted]' : sanitizeTelemetryData(item, depth + 1),
      ])
  );
}

export function scrubAnalyticsEvent(event) {
  if (!event) return null;
  // The SDK's envelope uses Date, not a plain diagnostics object. Keep its
  // serialization contract without changing how arbitrary properties scrub.
  const timestamp =
    event.timestamp instanceof Date && Number.isFinite(event.timestamp.getTime())
      ? event.timestamp
      : undefined;
  if (event.event !== '$exception') return { ...sanitizeTelemetryData(event), timestamp };
  // Covers SDK auto-capture as well as explicit captureException calls.
  return {
    event: '$exception',
    uuid: event.uuid,
    timestamp,
    properties: {
      distinct_id: event.properties?.distinct_id,
      $exception_list: [{ type: 'Error', value: 'Application error; diagnostic text omitted' }],
    },
  };
}

export function scrubTransactionEvent(event) {
  const trace = value => ({
    trace_id: /^[a-f0-9]{32}$/i.test(value?.trace_id || '') ? value.trace_id : undefined,
    span_id: /^[a-f0-9]{16}$/i.test(value?.span_id || '') ? value.span_id : undefined,
    parent_span_id: /^[a-f0-9]{16}$/i.test(value?.parent_span_id || '')
      ? value.parent_span_id
      : undefined,
    op: 'application',
  });
  const safe = scrubErrorEvent(event);
  delete safe.message;
  return {
    ...safe,
    type: 'transaction',
    transaction: 'Application transaction',
    start_timestamp: event.start_timestamp,
    contexts: { trace: trace(event.contexts?.trace) },
    spans: (event.spans || []).slice(0, 100).map(span => ({
      ...trace(span),
      start_timestamp: span.start_timestamp,
      timestamp: span.timestamp,
    })),
  };
}
