const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

test('commandments release gate includes every required verification family', () => {
  const scriptPath = path.join(root, 'scripts', 'verify-commandments.cjs');
  assert.equal(fs.existsSync(scriptPath), true, 'scripts/verify-commandments.cjs must exist');
  const source = fs.readFileSync(scriptPath, 'utf8');
  for (const gate of [
    'conflicts',
    'commandments-parity',
    'navigation',
    'error-envelope',
    'secrets',
    'client-types',
    'server-types',
    'matrix',
  ]) {
    assert.match(source, new RegExp(`name: '${gate}'`));
  }
  assert.match(source, /results\.some\(result => result\.exitCode !== 0\)/);
  assert.match(source, /git[\s\S]*rev-parse[\s\S]*HEAD/);
});

test('package exposes the commandments release gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:commandments'], 'node scripts/verify-commandments.cjs');
});

test('historical audits identify themselves as snapshots and link the canonical claims', () => {
  for (const file of [
    'docs/SYSTEM_ARCHITECTURE_AUDIT.md',
    'docs/COMPREHENSIVE_SECURITY_ARCHITECTURE_AUDIT_2026.md',
    'docs/SUBMISSION_READINESS_AUDIT.md',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /Historical snapshot/i, file);
    assert.match(source, /COMMANDMENTS\.md/, file);
  }
});
