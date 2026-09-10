const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanSources } = require('../check-error-disclosure.cjs');

test('rejects raw errors, local aliases, and reassigned display text', () => {
  for (const body of [
    "Alert.alert('Failed', err.message)",
    "const raw = err.data.message; Alert.alert('Failed', raw)",
    "let message; if (err) message = err.message; Alert.alert('Failed', message)",
    'setModal({ message: err.message })',
    'const view = <Text>{err.message}</Text>',
    'setError(toUserMessage(err, err.message))',
  ])
    assert.ok(scanSources({ 'app/example.tsx': `try {} catch (err) { ${body} }` }).length, body);
});
test('allows authored copy, safe helpers, and classification without echoing input', () => {
  for (const body of [
    "Alert.alert('Failed', toUserMessage(err, 'Please try again.'))",
    "setError(err.message.includes('timeout') ? 'Try again.' : 'Failed.')",
    "const text = toUserMessage(err, 'Failed.'); setError(text)",
  ])
    assert.equal(
      scanSources({ 'app/example.tsx': `try {} catch (err) { ${body} }` }).length,
      0,
      body
    );
});
test('rejects raw server response diagnostics', () => {
  assert.equal(
    scanSources({
      'server/example.ts': 'try {} catch (err) { res.status(500).json({ detail: err.message }); }',
    }).length,
    1
  );
});

test('recognizes arbitrary catch names and bracket access', () => {
  assert.equal(
    scanSources({
      'app/example.tsx': `try {} catch (failure) { Alert.alert('Failed', failure['message']); }`,
    }).length,
    1
  );
});
