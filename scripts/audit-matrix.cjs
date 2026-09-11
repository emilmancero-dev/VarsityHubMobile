#!/usr/bin/env node
// Static discovery is an inventory, never proof that a workflow passed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'config/matrix-coverage.json');
function scanSource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rows = [];
  const apiImports = new Set();
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      /(?:api|apiclient)\//.test(statement.moduleSpecifier.text || '')
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) apiImports.add(binding.name.text);
      if (statement.importClause?.name) apiImports.add(statement.importClause.name.text);
    }
  }
  const occurrences = new Map();
  function add(kind, label, node) {
    label = label.replace(/\s+/g, ' ').trim();
    const key = `${file}|${kind}|${label}`;
    const n = occurrences.get(key) || 0;
    occurrences.set(key, n + 1);
    const id = `${file}#${kind}:${crypto.createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 12)}`;
    rows.push({
      id,
      kind,
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      label,
    });
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(ast);
      const method = node.expression.name.text;
      const argument = node.arguments[0]?.getText(ast) || '';
      if (
        /^server\//.test(file) &&
        /^(get|post|put|patch|delete|options|head|all)$/.test(method) &&
        /(?:Router|router|app)$/.test(owner)
      ) {
        add(
          'endpoint',
          `${owner} ${method.toUpperCase()} ${argument.replace(/^['"]|['"]$/g, '')}`,
          node
        );
      } else if (
        /^server\//.test(file) &&
        method === 'use' &&
        /(?:Router|router|app)$/.test(owner)
      ) {
        add('mount', node.getText(ast), node);
      } else if (!file.startsWith('server/')) {
        if (/^(push|replace|navigate|dismissTo)$/.test(method) && /router|navigation/i.test(owner))
          add('navigation', node.getText(ast), node);
        if (
          apiImports.has(owner) ||
          (/^(get|post|put|patch|delete|request)$/.test(method) && /api|client|http/i.test(owner))
        )
          add('api-call', node.getText(ast), node);
      }
    }
    if (!file.startsWith('server/') && ts.isJsxAttribute(node)) {
      const name = node.name.getText(ast);
      if (
        /^on(Press|LongPress|Submit|ValueChange|ChangeText|Select|Confirm|Delete|Save|Refresh|Swipe)/.test(
          name
        )
      )
        add('action', `${node.parent.parent.tagName.getText(ast)} ${node.getText(ast)}`, node);
      if (name === 'href') add('navigation', node.getText(ast), node);
      if (name === 'name' && /(?:Tabs|Stack)\.Screen/.test(node.parent.parent.getText(ast)))
        add('registration', node.parent.parent.getText(ast), node);
    }
    if (
      !file.startsWith('server/') &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch'
    )
      add('api-call', node.getText(ast), node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return rows;
}
function discover() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }
  ).split('\0');
  const rows = [];
  for (const file of new Set(files)) {
    if (
      !/^(app|components|hooks|utils|context|api|apiclient|lib|constants|server\/src)\//.test(
        file
      ) ||
      !/\.[jt]sx?$/.test(file) ||
      /(__tests__|\.test\.|\.spec\.|\/__mocks__\/)/.test(file)
    )
      continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.startsWith('app/') && /export\s+default|export\s*\{[^}]*default/.test(source)) {
      rows.push({
        id: `${file}#screen`,
        kind: file.endsWith('_layout.tsx') ? 'layout' : 'screen',
        file,
        line: 1,
        label: file.slice(4).replace(/\.[jt]sx?$/, ''),
      });
    }
    rows.push(...scanSource(file, source));
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
function checkCoverage(rows, entries) {
  const ids = new Set(rows.map(r => r.id));
  const drift = rows.filter(r => !entries[r.id]).map(r => `Unmapped: ${r.id}`);
  for (const id of Object.keys(entries)) if (!ids.has(id)) drift.push(`Stale: ${id}`);
  const errors = [],
    gaps = [];
  for (const row of rows) {
    const entry = entries[row.id];
    if (!entry) continue;
    if (!['missing', 'partial', 'covered', 'excluded'].includes(entry.status))
      errors.push(`Invalid status: ${row.id}`);
    if (entry.status !== 'covered' && !entry.reason) errors.push(`Reason required: ${row.id}`);
    if (['covered', 'partial'].includes(entry.status)) {
      if (
        !entry.evidence?.length ||
        entry.evidence.some(e => !fs.existsSync(path.join(root, e.split('#')[0])))
      )
        errors.push(`Missing test evidence: ${row.id}`);
    }
    if (entry.status === 'covered' && (!entry.cases?.length || !entry.dimensions?.length))
      errors.push(`Named cases and applicable dimensions required: ${row.id}`);
    if (
      entry.status === 'covered' &&
      entry.cases?.length &&
      entry.evidence?.length &&
      entry.evidence.every(e => fs.existsSync(path.join(root, e.split('#')[0])))
    ) {
      const evidenceText = entry.evidence
        .map(e => {
          const file = path.join(root, e.split('#')[0]);
          return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        })
        .join('\n');
      if (entry.cases.some(name => !evidenceText.includes(name)))
        errors.push(`Named test case not found: ${row.id}`);
    }
    if (entry.status !== 'covered' && entry.status !== 'excluded') gaps.push(row.id);
  }
  return { drift, errors, gaps };
}
function main() {
  const rows = discover();
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, entries: {} };
  if (process.argv.includes('--refresh')) {
    // New rows remain missing; refreshing never grants coverage or deletes stale records.
    for (const row of rows)
      manifest.entries[row.id] ||= {
        status: 'missing',
        reason: 'Needs reviewed feature mapping and executable evidence.',
      };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  const result = checkCoverage(rows, manifest.entries);
  const counts = {};
  for (const row of rows) {
    const key = `${row.kind}/${manifest.entries[row.id]?.status || 'unmapped'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    counts,
    ...result,
    rows: rows.map(r => ({ ...r, ...manifest.entries[r.id] })),
  };
  const out = path.join(root, 'artifacts/matrix-audit');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '# Matrix coverage inventory',
    '',
    'Static discovery only. Test references are not execution results. UI states, role-dependent menus, dynamic routes and shared handlers require manual tracing.',
    '',
    '| Kind / status | Count |',
    '| --- | ---: |',
    ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `Drift: ${result.drift.length}; invalid evidence: ${result.errors.length}; coverage gaps: ${result.gaps.length}.`,
    '',
    '| Source | Kind | Status | Discovered surface |',
    '| --- | --- | --- | --- |',
    ...report.rows.map(
      r =>
        `| ${r.file}:${r.line} | ${r.kind} | ${r.status || 'unmapped'} | ${r.label.replace(/\|/g, '\\|').slice(0, 180)} |`
    ),
  ];
  fs.writeFileSync(path.join(out, 'inventory.md'), lines.join('\n') + '\n');
  console.log(
    JSON.stringify(
      {
        counts,
        drift: result.drift.length,
        errors: result.errors,
        coverageGaps: result.gaps.length,
        report: 'artifacts/matrix-audit/inventory.md',
      },
      null,
      2
    )
  );
  if (
    result.drift.length ||
    result.errors.length ||
    (process.argv.includes('--strict') && result.gaps.length)
  )
    process.exitCode = 1;
}
module.exports = { scanSource, checkCoverage, discover };
if (require.main === module) main();
