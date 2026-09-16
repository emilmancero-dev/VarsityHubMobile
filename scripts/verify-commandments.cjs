#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'artifacts', 'commandments-verification.json');
const gates = [
  { name: 'conflicts', command: 'npm', args: ['run', 'check:conflicts'] },
  {
    name: 'commandments-parity',
    command: 'npm',
    args: [
      '--prefix',
      'server',
      'test',
      '--',
      '--watchman=false',
      '--runInBand',
      '--runTestsByPath',
      'src/__tests__/commandments-invariants.test.ts',
    ],
  },
  { name: 'navigation', command: 'npm', args: ['run', 'audit:navigation:fail'] },
  { name: 'error-envelope', command: 'npm', args: ['run', 'verify:error-envelope'] },
  { name: 'secrets', command: 'npm', args: ['run', 'verify:secrets'] },
  { name: 'client-types', command: 'npx', args: ['tsc', '--noEmit'] },
  {
    name: 'server-types',
    command: 'npx',
    args: ['tsc', '--noEmit', '--project', 'server/tsconfig.json'],
  },
  { name: 'matrix', command: 'node', args: ['scripts/run-matrix-audit.cjs'] },
];

const results = [];
for (const gate of gates) {
  console.log(`\n[commandments] ${gate.name}`);
  const result = spawnSync(gate.command, gate.args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  results.push({
    name: gate.name,
    command: [gate.command, ...gate.args],
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
  });
}

const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
});
const failed = results.some(result => result.exitCode !== 0);
const report = {
  generatedAt: new Date().toISOString(),
  commit: commitResult.status === 0 ? commitResult.stdout.trim() : null,
  node: process.version,
  status: failed ? 'FAILED_OR_INCOMPLETE' : 'PASS',
  results,
  installedAppJourneys: 'NOT_RUN',
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(`\n[commandments] ${report.status}; report: ${path.relative(root, outputPath)}`);
if (failed) process.exitCode = 1;
