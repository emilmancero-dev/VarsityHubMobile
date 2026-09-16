const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanSource, checkCoverage, evaluateWorkflowRegistry } = require('../audit-matrix.cjs');

test('workflow readiness is based on claims and evidence, not raw surface count', () => {
  assert.equal(typeof evaluateWorkflowRegistry, 'function');
  const result = evaluateWorkflowRegistry(
    {
      claims: [
        { id: 'CMD-A', status: 'CURRENT', workflows: ['FLOW-A'] },
        { id: 'CMD-B', status: 'ROADMAP', workflows: [] },
      ],
      workflows: [
        {
          id: 'FLOW-A',
          risk: 'high',
          status: 'verified',
          evidence: [{ type: 'automated', file: 'tests/a.test.ts', cases: ['works'] }],
        },
      ],
    },
    {
      exists: file => file === 'tests/a.test.ts',
      read: () => "test('works', () => {})",
    }
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.totalClaims, 2);
  assert.equal(result.summary.verifiedCurrentClaims, 1);
  assert.equal(result.summary.roadmapClaims, 1);
  assert.equal(result.summary.releaseBlockingWorkflows, 0);
});

test('current claims without workflows and critical workflows without required evidence block release', () => {
  const result = evaluateWorkflowRegistry(
    {
      claims: [
        { id: 'CMD-A', status: 'CURRENT', workflows: [] },
        { id: 'CMD-B', status: 'CURRENT', workflows: ['FLOW-B'] },
      ],
      workflows: [{ id: 'FLOW-B', risk: 'critical', status: 'verified', evidence: [] }],
    },
    { exists: () => false, read: () => '' }
  );
  assert.ok(result.errors.some(error => error.includes('CMD-A')));
  assert.ok(result.errors.some(error => error.includes('FLOW-B')));
  assert.equal(result.summary.releaseBlockingWorkflows, 1);
});

test('matrix runner disables Watchman for isolated server Jest suites', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-matrix-audit.cjs'), 'utf8');
  assert.match(
    runner,
    /\[\s*'--prefix',\s*'server',\s*'test',\s*'--',\s*'--watchman=false',\s*'--runInBand'/
  );
});
test('discovers multiline routes, dynamic navigation, controls and API calls without comments', () => {
  const rows = scanSource(
    'app/tools.tsx',
    `// router.push('/fake')
    const view = <Button onPress={save} />;
    router.push({ pathname: '/team-page', params: { id } });
    api.post('/games', payload);`
  );
  assert.deepEqual(rows.map(r => r.kind).sort(), ['action', 'api-call', 'navigation']);
  const routes = scanSource(
    'server/src/routes/games.ts',
    `gamesRouter.post(\n '/:id/approve', requireAuth, handler);`
  );
  assert.equal(routes[0].label, 'gamesRouter POST /:id/approve');
});
test('unmapped additions and removed evidence fail; missing coverage is distinct from inventory drift', () => {
  const rows = [{ id: 'a', kind: 'screen', file: 'app/a.tsx', label: 'a' }];
  assert.equal(checkCoverage(rows, {}).drift.length, 1);
  const mapped = { a: { status: 'missing', reason: 'Needs a UI journey', evidence: [] } };
  assert.equal(checkCoverage(rows, mapped).drift.length, 0);
  assert.equal(checkCoverage(rows, mapped).gaps.length, 1);
  assert.equal(
    checkCoverage(rows, {
      a: {
        status: 'covered',
        cases: ['case'],
        dimensions: ['ownership'],
        evidence: ['does-not-exist'],
      },
    }).errors.length,
    1
  );
});
test('API entity methods and renamed test cases cannot be overlooked', () => {
  const rows = scanSource('app/team.tsx', "import { Team } from '@/api/entities'; Team.list();");
  assert.equal(rows[0].kind, 'api-call');
  const result = checkCoverage([{ id: 'a' }], {
    a: {
      status: 'covered',
      evidence: ['scripts/__tests__/matrix-inventory.test.cjs'],
      cases: ['nonexistent' + '-case-name'],
      dimensions: ['ownership'],
    },
  });
  assert.equal(result.errors.length, 1);
});
