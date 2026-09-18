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
  ['workflow-readiness', 'node', ['scripts/audit-matrix.cjs', '--strict']],
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
// Deterministic gates: a failure here is always real, so never retry (retrying
// only doubles the cost of a static check or the by-design workflow-readiness
// device-evidence gate). Everything else is an executable test suite that can
// flake under full-run system load (e.g. concurrent requests contending for the
// connection_limit=1 test pool) — retry those ONCE and label a pass-on-retry as
// flaky. A genuinely broken suite fails both attempts and is still marked FAIL.
const NON_RETRYABLE = new Set([
  'inventory',
  'workflow-readiness',
  'client-types',
  'server-types',
  'error-envelope',
  'secrets',
]);

function runGate(name, command, args) {
  const fd = fs.openSync(path.join(out, `${name}.log`), 'w');
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: ['ignore', fd, fd],
    timeout: 180000,
  });
  fs.closeSync(fd);
  return result;
}

const results = [];
for (const [name, command, args] of commands) {
  console.log(`Running ${name}…`);
  let result = runGate(name, command, args);
  let flaky = false;
  if (result.status !== 0 && !NON_RETRYABLE.has(name)) {
    console.log(`${name}: FAIL on first attempt — retrying once to rule out a flake…`);
    // Preserve the failing attempt's log before the retry overwrites it, so a
    // FLAKY label is actually diagnosable (the retry reopens ${name}.log in 'w').
    const firstLog = path.join(out, `${name}.log`);
    if (fs.existsSync(firstLog)) fs.copyFileSync(firstLog, path.join(out, `${name}.attempt1.log`));
    const retry = runGate(name, command, args);
    if (retry.status === 0) {
      flaky = true;
      console.log(
        `${name}: FLAKY (failed once, passed on retry) — not a hard failure, but investigate ${name}.attempt1.log`
      );
    }
    result = retry;
  }
  results.push({
    name,
    command: [command, ...args],
    exitCode: result.status,
    error: result.error?.message,
    signal: result.signal,
    flaky,
    log: `artifacts/matrix-audit/${name}.log`,
  });
  console.log(`${name}: ${result.status === 0 ? (flaky ? 'PASS (flaky)' : 'PASS') : 'FAIL'}`);
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
  `Unclassified surfaces: ${inventory.gaps.length}. This is diagnostic inventory, not a defect count.`
);
const failed = results.some(r => r.exitCode !== 0);
const flakyGates = results.filter(r => r.flaky).map(r => r.name);
if (flakyGates.length)
  console.log(`Flaky gates (passed only on retry — investigate): ${flakyGates.join(', ')}`);
fs.writeFileSync(
  path.join(out, 'execution.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      results,
      unclassifiedSurfaces: inventory.gaps.length,
      workflowReadiness: inventory.workflowReadiness?.summary,
      flakyGates,
      overallStatus: failed ? 'INCOMPLETE_OR_FAILED' : 'PASS',
      uiDeviceJourneys: 'NOT RUN: component tests do not prove installed-app workflows',
    },
    null,
    2
  ) + '\n'
);
if (failed) process.exitCode = 1;
