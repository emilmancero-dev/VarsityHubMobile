#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverRoot = path.join(root, 'server');

function validateTestDatabaseUrl(value) {
  if (!value) throw new Error('COMMANDMENTS_TEST_DATABASE_URL is required');
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\//, '');
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing database "${database}": test database name must end in _test`);
  }
  return value;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  let databaseUrl;
  try {
    databaseUrl = validateTestDatabaseUrl(process.env.COMMANDMENTS_TEST_DATABASE_URL);
  } catch (error) {
    console.error(`[commandments-db] ${error.message}`);
    process.exit(2);
  }
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  run('npx', ['prisma', 'migrate', 'deploy'], serverRoot, env);
  const suites = [
    'src/__tests__/purge-unposted-event-pages.test.ts',
    'src/__tests__/users-event-pages.test.ts',
    'src/__tests__/minors-foundation.test.ts',
    'src/__tests__/role-barrier-authorization.test.ts',
  ];
  for (const suite of suites) {
    run(
      'npm',
      ['test', '--', '--watchman=false', '--runInBand', '--runTestsByPath', suite],
      serverRoot,
      env
    );
  }
}

module.exports = { validateTestDatabaseUrl };
if (require.main === module) main();
