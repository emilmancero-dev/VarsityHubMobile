import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runAudit, exitCode, toMarkdown } from './audit-check';
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'audit-test-'));
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), s);
  }
  return root;
}
const good = {
  'app/index.tsx': 'export default function Home() {}',
  'apiclient/client.ts': 'fetch("/api")',
  'utils/deepLinks.ts': 'const ROUTE_MAP = { home: "/" };',
  'utils/formUtils.ts': 'export const USERNAME_REGEX = /^[a-z0-9_.]+$/;',
  'server/src/routes/auth.ts': 'const schema = {username: z.string().regex(/^[a-z0-9_.]+$/)};',
};
test('three scoped checks pass with positive input evidence; manual gates remain unresolved', () => {
  const root = fixture(good);
  try {
    const r = runAudit(root);
    assert.equal(r.summary.passed, 3);
    assert.equal(r.summary.needsReview, 3);
    assert.equal(exitCode(r), 0);
    assert.match(toMarkdown(r), /needs-review/);
    assert.equal(r.kind, 'automated');
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('real violations fail; comments, strings and method refetch do not count as fetch calls', () => {
  const root = fixture({
    ...good,
    'app/index.tsx':
      '// fetch("ignored")\nconst x="fetch("; query.refetch(); globalThis.fetch("/bad");',
    'utils/deepLinks.ts': 'const ROUTE_MAP={bad:"/missing"};',
    'utils/formUtils.ts': 'const USERNAME_REGEX = /^[A-Z]+$/;',
  });
  try {
    const r = runAudit(root);
    assert.equal(r.summary.failed, 3);
    assert.equal(exitCode(r), 1);
    assert.ok(r.checks[0].evidence.some(x => x.includes('app/index.tsx:2')));
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('missing inputs never pass silently', () => {
  const root = fixture({});
  try {
    const r = runAudit(root);
    assert.equal(r.summary.passed, 0);
    assert.equal(r.summary.needsReview, 6);
    assert.equal(exitCode(r), 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('only critical/high failures block and markdown faithfully includes evidence', () => {
  const root = fixture(good);
  try {
    const r = runAudit(root);
    r.checks = [
      {
        id: 'x',
        title: 'x',
        severity: 'Medium',
        status: 'failed',
        details: 'warning',
        evidence: ['app/index.tsx:1'],
      },
    ];
    assert.equal(exitCode(r), 0);
    assert.match(toMarkdown(r), /app\/index.tsx:1/);
    r.checks[0].severity = 'Critical';
    assert.equal(exitCode(r), 1);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('CLI preserves report fidelity and exit status for selected checks and rejects unknown IDs', () => {
  const root = fixture({ ...good, 'app/index.tsx': 'fetch("/bad")' });
  try {
    const cli = join(__dirname, '../tools/audit/node_modules/.bin/tsx');
    const script = join(__dirname, 'audit-check.ts');
    const json = join(root, 'out/report.json'),
      md = join(root, 'out/report.md');
    const result = spawnSync(
      cli,
      [script, '--root', root, '--json', json, '--markdown', md, '--check', 'no-fetch-outside-api'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.equal(readFileSync(md, 'utf8'), result.stdout);
    const report = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(report.checks.length, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(
      spawnSync(cli, [script, '--root', root, '--check', 'unknown'], { encoding: 'utf8' }).status,
      2
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('dynamic declarations and malformed source are unresolved rather than false passes', () => {
  const root = fixture({
    ...good,
    'utils/deepLinks.ts': 'const ROUTE_MAP = { home: getHome() };',
    'utils/formUtils.ts': 'const USERNAME_REGEX = new RegExp(".+");',
    'app/index.tsx': 'export const broken = (',
  });
  try {
    const report = runAudit(root);
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.needsReview, 6);
    assert.equal(report.summary.failed, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('Expo route groups and directory index resolve, but layouts do not count as screens', () => {
  const root = fixture({
    ...good,
    'app/(tabs)/settings/index.tsx': 'export default function Settings() {}',
    'app/private/_layout.tsx': 'export default function Layout() {}',
    'utils/deepLinks.ts':
      'const ROUTE_MAP = { settings: "/settings", layout: "/private/_layout" };',
  });
  try {
    const check = runAudit(root).checks.find(c => c.id === 'deep-link-coverage')!;
    assert.equal(check.status, 'failed');
    assert.deepEqual(check.evidence, ['utils/deepLinks.ts: missing app route /private/_layout']);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('mixed literal and dynamic backend username regex cannot produce a parity pass', () => {
  for (const validator of [
    "z.string().regex(new RegExp('.*'))",
    'z.string().regex(USERNAME_PATTERN)',
    'z.string()',
  ]) {
    const root = fixture({
      ...good,
      'server/src/routes/auth.ts': `const signup = { username: z.string().regex(/^[a-z0-9_.]+$/) }; const update = { username: ${validator} };`,
    });
    try {
      const check = runAudit(root).checks.find(c => c.id === 'validation-drift')!;
      assert.equal(check.status, 'needs-review');
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('referenced username schema inside Zod object is unresolved', () => {
  const root = fixture({
    ...good,
    'server/src/routes/auth.ts':
      'const signup = z.object({username: z.string().regex(/^[a-z0-9_.]+$/)}); const update = z.object({username: importedSchema});',
  });
  try {
    assert.equal(
      runAudit(root).checks.find(c => c.id === 'validation-drift')!.status,
      'needs-review'
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
