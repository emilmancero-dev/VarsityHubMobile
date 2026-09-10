import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSentryBreadcrumbData } from '../../shared/runtime/sentrySanitization.js';

test('nested credentials are removed before telemetry serialization', () => {
  const result = normalizeSentryBreadcrumbData({
    payload: { rows: [{ password: 'private-value', ok: true }] },
  });
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('bounded serialization handles cyclic context without exposing credentials', () => {
  const value = { password: 'private-value' };
  value.self = value;
  assert.ok(!JSON.stringify(normalizeSentryBreadcrumbData({ value })).includes('private-value'));
});
