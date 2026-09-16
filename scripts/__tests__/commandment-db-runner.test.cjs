const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runnerPath = path.join(__dirname, '..', 'run-commandment-db-tests.cjs');

test('database runner exists and rejects non-test databases', () => {
  assert.equal(fs.existsSync(runnerPath), true);
  const { validateTestDatabaseUrl } = require(runnerPath);
  assert.throws(
    () => validateTestDatabaseUrl('postgresql://localhost:5432/varsityhub'),
    /must end in _test/
  );
  assert.equal(
    validateTestDatabaseUrl('postgresql://localhost:5432/varsityhub_commandments_test'),
    'postgresql://localhost:5432/varsityhub_commandments_test'
  );
});

test('database runner includes the blocked commandment integration suites', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.match(source, /purge-unposted-event-pages\.test\.ts/);
  assert.match(source, /users-event-pages\.test\.ts/);
  assert.match(source, /minors-foundation\.test\.ts/);
  assert.match(source, /role-barrier-authorization\.test\.ts/);
});
