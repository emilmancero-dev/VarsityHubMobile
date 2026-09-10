import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankState,
  mergeStates,
  restoreState,
  buildReport,
  toMarkdown,
} from '../src/features/audit/state.ts';
const item = {
  id: 'auth-001',
  title: 'Ownership',
  category: 'auth' as const,
  ruleType: 'Audit Steps' as const,
  severity: 'Critical' as const,
  description: 'Check ownership',
  verification: 'Use two users',
  affectedFiles: ['server/src'],
  remediation: 'Enforce owner',
};
const checklist = { version: '1.0.0', title: 'Audit', items: [item] };
test('stale versions are rejected without silently importing attestations', () => {
  const s = blankState('0.9.0');
  assert.throws(() => restoreState(JSON.stringify(s), '1.0.0'), /version/i);
});
test('malformed storage is rejected', () => assert.throws(() => restoreState('{broken', '1.0.0')));
test('cross-tab merge preserves independent entries and newer edits', () => {
  const a = blankState('1.0.0'),
    b = blankState('1.0.0');
  a.entries.x = { status: 'passed', notes: 'proof', reviewer: 'A', updatedAt: 2 };
  b.entries.y = { status: 'failed', notes: 'logs', reviewer: 'B', updatedAt: 3 };
  b.entries.x = { status: 'unchecked', notes: '', reviewer: 'B', updatedAt: 1 };
  const merged = mergeStates(a, b);
  assert.equal(merged.entries.x.status, 'passed');
  assert.equal(merged.entries.y.status, 'failed');
  assert.deepEqual(mergeStates(a, b), mergeStates(b, a));
});
test('same timestamp conflicts merge deterministically', () => {
  const a = blankState('1.0.0'),
    b = blankState('1.0.0');
  a.entries.x = { status: 'passed', notes: 'a', reviewer: 'A', updatedAt: 1 };
  b.entries.x = { status: 'failed', notes: 'b', reviewer: 'B', updatedAt: 1 };
  assert.deepEqual(mergeStates(a, b), mergeStates(b, a));
});
test('failed items need notes before JSON or Markdown export', () => {
  const s = blankState('1.0.0');
  s.entries[item.id] = { status: 'failed', notes: ' ', reviewer: '', updatedAt: 1 };
  assert.throws(() => buildReport(checklist, s), /notes/i);
  s.entries[item.id].notes = 'Two users can access the same private record';
  const report = buildReport(checklist, s);
  assert.equal(report.uncheckedItems[0], item.id);
  assert.equal(report.summary.failed, 1);
  assert.match(toMarkdown(report), /Two users/);
});
test('fresh reports identify unresolved questions and do not claim a pass', () => {
  const report = buildReport(checklist, blankState('1.0.0'));
  assert.equal(report.summary.passed, 0);
  assert.equal(report.items[0].status, 'unchecked');
  assert.equal(report.categoryBreakdown.auth.total, 1);
  assert.match(toMarkdown(report), /human review/i);
});
