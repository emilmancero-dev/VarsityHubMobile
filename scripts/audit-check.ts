/** Scoped source checks, not a security certification. Unsupported analysis stays needs-review. */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const ts = createRequire(resolve(__dirname, '../tools/audit/package.json'))(
  'typescript'
) as typeof import('../tools/audit/node_modules/typescript');
export type Check = {
  id: string;
  title: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'passed' | 'failed' | 'needs-review';
  details: string;
  evidence: string[];
};
export type Report = {
  schemaVersion: '1.0.0';
  checklistVersion: '1.0.0';
  generatedAt: string;
  kind: 'automated';
  source: { type: 'local' | 'github-actions'; commit?: string; runUrl?: string };
  summary: { passed: number; failed: number; needsReview: number };
  checks: Check[];
};
function files(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap(e =>
    e.isSymbolicLink() || ['node_modules', '__tests__', '.git', 'dist'].includes(e.name)
      ? []
      : e.isDirectory()
        ? files(root, join(dir, e.name))
        : /\.[cm]?[jt]sx?$/.test(e.name) && !/(\.test\.|\.spec\.|\.d\.ts$)/.test(e.name)
          ? [join(dir, e.name)]
          : []
  );
}
function parse(root: string, file: string) {
  const src = readFileSync(join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const errors = (ast as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;
  if (errors.length) throw new Error(`Cannot parse ${file}`);
  return ast;
}
function walk(
  node: import('../tools/audit/node_modules/typescript').Node,
  visit: (node: import('../tools/audit/node_modules/typescript').Node) => void
) {
  visit(node);
  ts.forEachChild(node, n => walk(n, visit));
}
function check(
  id: string,
  title: string,
  severity: Check['severity'],
  run: () => Omit<Check, 'id' | 'title' | 'severity'>
): Check {
  try {
    return { id, title, severity, ...run() };
  } catch (e) {
    return {
      id,
      title,
      severity,
      status: 'needs-review',
      details: `Input unavailable or unsupported: ${e instanceof Error ? e.message : String(e)}`,
      evidence: [],
    };
  }
}
export function checkNoFetchOutsideAPI(root: string): Check {
  return check('no-fetch-outside-api', 'Direct fetch calls stay in API adapters', 'High', () => {
    const paths = [
      'app',
      'components',
      'hooks',
      'utils',
      'context',
      'src',
      'api',
      'apiclient',
    ].flatMap(p => files(root, p));
    if (!paths.length) throw new Error('No client source files found');
    const hits: string[] = [];
    for (const p of paths) {
      if (/^(api|apiclient)\//.test(p) || /^src\/api\//.test(p)) continue;
      const ast = parse(root, p);
      walk(ast, n => {
        if (!ts.isCallExpression(n)) return;
        const e = n.expression;
        const isFetch =
          (ts.isIdentifier(e) && e.text === 'fetch') ||
          (ts.isPropertyAccessExpression(e) &&
            ['globalThis', 'window', 'self'].includes(e.expression.getText(ast)) &&
            e.name.text === 'fetch');
        if (isFetch)
          hits.push(`${p}:${ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1}`);
      });
    }
    return {
      status: hits.length ? 'failed' : 'passed',
      details: `Scanned ${paths.length} client files for direct fetch/globalThis.fetch/window.fetch/self.fetch calls. API adapters are api/, apiclient/, src/api/. Aliases and other network libraries require review; local-file and OAuth fetch calls also require architectural review.`,
      evidence: hits.length ? hits : [`${paths.length} source files parsed`],
    };
  });
}
export function checkValidationDrift(root: string): Check {
  return check('validation-drift', 'Canonical username regex parity', 'High', () => {
    const client = 'utils/formUtils.ts',
      server = 'server/src/routes/auth.ts';
    const a: string[] = [],
      b: string[] = [];
    walk(parse(root, client), n => {
      if (
        ts.isVariableDeclaration(n) &&
        n.name.getText() === 'USERNAME_REGEX' &&
        n.initializer &&
        ts.isRegularExpressionLiteral(n.initializer)
      )
        a.push(n.initializer.text);
    });
    walk(parse(root, server), n => {
      if (
        !ts.isPropertyAssignment(n) ||
        !(ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ||
        n.name.text !== 'username'
      )
        return;
      let regexCalls = 0;
      const containerCall = n.parent.parent;
      let hasZodCall =
        ts.isCallExpression(containerCall) &&
        ts.isPropertyAccessExpression(containerCall.expression) &&
        ts.isIdentifier(containerCall.expression.expression) &&
        containerCall.expression.expression.text === 'z' &&
        containerCall.expression.name.text === 'object';
      walk(n.initializer, m => {
        if (!ts.isCallExpression(m) || !ts.isPropertyAccessExpression(m.expression)) return;
        const callee = m.expression;
        if (ts.isIdentifier(callee.expression) && callee.expression.text === 'z') hasZodCall = true;
        if (callee.name.text !== 'regex') return;
        regexCalls++;
        const pattern = m.arguments[0];
        if (!pattern || !ts.isRegularExpressionLiteral(pattern))
          throw new Error(
            'Backend username regex uses an unsupported dynamic pattern; review every username schema'
          );
        b.push(pattern.text);
      });
      if (hasZodCall && !regexCalls)
        throw new Error('Backend username schema has no comparable literal regex');
    });
    if (a.length !== 1 || !b.length)
      throw new Error('Expected literal USERNAME_REGEX and username schema regex not found');
    return {
      status: b.every(v => v === a[0]) ? 'passed' : 'failed',
      details:
        'Compares literal username regex in canonical client helper and backend username schema only. Length, normalization, email, password and runtime validation remain manual review.',
      evidence: [
        `${client}: USERNAME_REGEX = ${a[0]}`,
        `${server}: username regex = ${b.join(', ')}`,
      ],
    };
  });
}
export function checkDeepLinkCoverage(root: string): Check {
  return check(
    'deep-link-coverage',
    'Declared deep-link destinations resolve to Expo routes',
    'High',
    () => {
      const paths = files(root, 'app');
      if (!paths.length) throw new Error('Expo app routes unavailable');
      const routes = new Set(
        paths
          .map(
            p =>
              '/' +
              p
                .replace(/^app\//, '')
                .replace(/\.[jt]sx?$/, '')
                .split('/')
                .filter(x => !/^\(.*\)$/.test(x))
                .join('/')
                .replace(/(^|\/)index$/, '')
          )
          .filter(p => !p.includes('_layout'))
      );
      const targets: string[] = [];
      const source = 'utils/deepLinks.ts';
      walk(parse(root, source), n => {
        if (
          ts.isVariableDeclaration(n) &&
          n.name.getText() === 'ROUTE_MAP' &&
          n.initializer &&
          ts.isObjectLiteralExpression(n.initializer)
        )
          for (const prop of n.initializer.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.initializer))
              throw new Error('ROUTE_MAP contains dynamic destinations');
            targets.push(prop.initializer.text);
          }
      });
      if (!targets.length)
        throw new Error('Literal ROUTE_MAP unavailable; no invented all-route navigation registry');
      const missing = [...new Set(targets)].filter(p => !routes.has(p));
      return {
        status: missing.length ? 'failed' : 'passed',
        details: `Resolved ${new Set(targets).size} declared ROUTE_MAP destinations against ${paths.length} Expo source files. This does not prove authorization, parameter safety, or that every screen should be externally linkable.`,
        evidence: missing.length
          ? missing.map(p => `${source}: missing app route ${p}`)
          : [`${source}: all declared destinations resolve`],
      };
    }
  );
}
export function runAudit(root: string): Report {
  root = resolve(root);
  const checks = [
    checkNoFetchOutsideAPI(root),
    checkValidationDrift(root),
    checkDeepLinkCoverage(root),
    ...(
      [
        {
          id: 'webhook-idempotency',
          title: 'Webhook replay and concurrent delivery safety',
          severity: 'Critical',
          path: 'server/src/routes/payments.ts',
          details:
            'Manual review required: execute duplicate and concurrent delivery tests and inspect unique constraints and transaction boundaries. Presence of a dedup marker cannot prove duplicate-safe writes.',
        },
        {
          id: 'audit-log-calls',
          title: 'Sensitive admin actions produce durable audit events',
          severity: 'High',
          path: 'server/src/lib/adminActivityLogger.ts',
          details:
            'Manual review required: exercise each sensitive admin action and verify actor, target and outcome in durable logs, including logger failure. Nearby log calls alone do not prove complete coverage.',
        },
        {
          id: 'payment-state-ownership',
          title: 'Payment state is owned by verified server transitions',
          severity: 'Critical',
          path: 'server/src/routes/payments.ts',
          details:
            'Manual review required: tamper with client payment fields and verify backend rejects changes; inspect receipt/signature validation and ownership. Source scanning cannot establish trusted state transitions.',
        },
      ] as const
    ).map(c => ({
      id: c.id,
      title: c.title,
      severity: c.severity,
      status: 'needs-review' as const,
      details: c.details,
      evidence: [existsSync(join(root, c.path)) ? c.path : `Unavailable expected input: ${c.path}`],
    })),
  ];
  const gh = process.env.GITHUB_ACTIONS === 'true';
  return {
    schemaVersion: '1.0.0',
    checklistVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    kind: 'automated',
    source: gh
      ? {
          type: 'github-actions',
          commit: process.env.GITHUB_SHA,
          runUrl:
            process.env.GITHUB_SERVER_URL &&
            process.env.GITHUB_REPOSITORY &&
            process.env.GITHUB_RUN_ID
              ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
              : undefined,
        }
      : { type: 'local' },
    summary: {
      passed: checks.filter(c => c.status === 'passed').length,
      failed: checks.filter(c => c.status === 'failed').length,
      needsReview: checks.filter(c => c.status === 'needs-review').length,
    },
    checks,
  };
}
export function exitCode(report: Report) {
  return report.checks.some(c => c.status === 'failed' && ['Critical', 'High'].includes(c.severity))
    ? 1
    : 0;
}
const escape = (value: string) => value.replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;'));
function evidenceMarkdown(evidence: string, report: Report) {
  const location = /^([^:]+\.[jt]sx?)(?::(\d+))?(?:: (.*))?$/.exec(evidence);
  const run =
    report.source.runUrl &&
    /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/actions\/runs\/\d+$/.exec(report.source.runUrl);
  if (location && run && report.source.commit && /^[a-f0-9]{40}$/i.test(report.source.commit)) {
    const url = `${run[1]}/blob/${report.source.commit}/${location[1].split('/').map(encodeURIComponent).join('/')}${location[2] ? `#L${location[2]}` : ''}`;
    return `[${escape(location[1])}${location[2] ? `:${location[2]}` : ''}](${url})${location[3] ? `: ${escape(location[3])}` : ''}`;
  }
  return escape(evidence);
}
export function toMarkdown(report: Report) {
  return (
    `# Security & architecture audit\n\nFramework ${report.checklistVersion} · ${report.generatedAt}\n\n${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.needsReview} need review\n\nAutomated checks have limited scope. Needs-review is unresolved, not passed.\n\n` +
    report.checks
      .map(
        c =>
          `## ${escape(c.title)}\n\n**${c.status} · ${c.severity}** (${c.id})\n\n${escape(c.details)}\n\n${c.evidence.map(e => `- ${evidenceMarkdown(e, report)}`).join('\n')}\n`
      )
      .join('\n')
  );
}
export function main(args = process.argv.slice(2)) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--root', '--json', '--markdown', '--check'].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error(`Invalid argument: ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  const report = runAudit(options['--root'] || process.cwd());
  if (options['--check']) {
    report.checks = report.checks.filter(c => c.id === options['--check']);
    if (!report.checks.length) throw new Error('Unknown check ID');
    report.summary = {
      passed: report.checks.filter(c => c.status === 'passed').length,
      failed: report.checks.filter(c => c.status === 'failed').length,
      needsReview: report.checks.filter(c => c.status === 'needs-review').length,
    };
  }
  const md = toMarkdown(report);
  for (const [p, body] of [
    [options['--json'] || '/tmp/audit-report.json', JSON.stringify(report, null, 2) + '\n'],
    [options['--markdown'] || '/tmp/audit-report.md', md],
  ]) {
    mkdirSync(dirname(resolve(p)), { recursive: true });
    writeFileSync(p, body);
  }
  process.stdout.write(md);
  return exitCode(report);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`Audit runner error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
