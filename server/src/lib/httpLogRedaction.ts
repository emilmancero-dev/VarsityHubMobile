const TOKEN_QUERY_PARAM_RE =
  /(^|[?&#])([^=&#\s]*(?:token|password|secret|api[_-]?key|code|authorization)[^=&#\s]*)=[^&#\s]*/gi;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'stripe-signature',
  'x-health-check-secret',
  'x-idempotency-key',
  'x-sendgrid-event-webhook-signature',
  'x-sendgrid-event-webhook-timestamp',
]);

export function redactUrlTokens(url: string): string {
  return url.replace(TOKEN_QUERY_PARAM_RE, (_match, prefix, key) => `${prefix}${key}=[redacted]`);
}

export function redactSensitiveHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const redacted = { ...(headers as Record<string, unknown>) };
  for (const key of Object.keys(redacted)) {
    if (
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ||
      /token|password|secret|api[-_]?key/i.test(key)
    ) {
      redacted[key] = '[redacted]';
    }
  }
  return redacted;
}

export function redactSerializedRequest<T extends { url?: unknown; headers?: unknown }>(
  request: T
): T {
  if (typeof request.url === 'string') {
    request.url = redactUrlTokens(request.url);
  }
  request.headers = redactSensitiveHeaders(request.headers);
  return request;
}
