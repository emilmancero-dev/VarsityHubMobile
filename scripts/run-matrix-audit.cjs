#!/usr/bin/env node
// Run every gate even after a failure; retain exact exit codes and logs.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const suites = require('../config/matrix-suites.json');
const out = path.join(root, 'artifacts/matrix-audit');
fs.mkdirSync(out, { recursive: true });
const commands = [
  ['inventory', 'node', ['scripts/audit-matrix.cjs']],
  ['inventory-tests', 'node', ['--test', 'scripts/__tests__/matrix-inventory.test.cjs']],
  ['navigation', 'npm', ['run', 'audit:navigation:fail']],
  ['client', 'npm', ['test', '--', '--runTestsByPath', ...suites.client]],
  // Separate processes avoid ESM registry collisions between server suites.
  ...suites.server.map(file => [
    path.basename(file, '.test.ts'),
    'npm',
    [
      '--prefix',
      'server',
      'test',
      '--',
      '--watchman=false',
      '--runInBand',
      '--runTestsByPath',
      file,
    ],
  ]),
  ['client-types', 'npx', ['tsc', '--noEmit']],
  ['server-types', 'npx', ['tsc', '--noEmit', '--project', 'server/tsconfig.json']],
  ['error-envelope', 'npm', ['run', 'verify:error-envelope']],
  ['secrets', 'npm', ['run', 'verify:secrets']],
];
const results = [];
for (const [name, command, args] of commands) {
  console.log(`Running ${name}…`);
  const fd = fs.openSync(path.join(out, `${name}.log`), 'w');
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: ['ignore', fd, fd],
    timeout: 180000,
  });
  fs.closeSync(fd);
  results.push({
    name,
    command: [command, ...args],
    exitCode: result.status,
    error: result.error?.message,
    signal: result.signal,
    log: `artifacts/matrix-audit/${name}.log`,
  });
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(
    path.join(out, 'execution.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results,
        uiDeviceJourneys: 'NOT RUN: component tests do not prove installed-app workflows',
      },
      null,
      2
    ) + '\n'
  );
}
const inventory = JSON.parse(fs.readFileSync(path.join(out, 'inventory.json'), 'utf8'));
console.log(
  `Coverage gaps: ${inventory.gaps.length}. These remain open regardless of test results.`
);
const failed = results.some(r => r.exitCode !== 0) || inventory.gaps.length > 0;
fs.writeFileSync(
  path.join(out, 'execution.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      results,
      coverageGaps: inventory.gaps.length,
      overallStatus: failed ? 'INCOMPLETE_OR_FAILED' : 'PASS',
      uiDeviceJourneys: 'NOT RUN: component tests do not prove installed-app workflows',
    },
    null,
    2
  ) + '\n'
);
if (failed) process.exitCode = 1;
