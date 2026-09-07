const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function safeSarif(result) {
  const root = path.resolve(__dirname, '..');
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: result.runs.map(run => ({
      tool: { driver: { name: 'Snyk Code' } },
      results: run.results.map(item => ({
        ruleId: item.ruleId,
        level: item.level,
        message: {
          text: `Snyk Code finding: ${item.ruleId || 'unknown rule'}. Review the referenced source.`,
        },
        locations: (item.locations || []).map(location => {
          const physical = location.physicalLocation || {};
          const uri = physical.artifactLocation?.uri || '';
          const absolute = uri.startsWith('file:') ? new URL(uri).pathname : path.resolve(uri);
          return {
            physicalLocation: {
              artifactLocation: { uri: path.relative(root, absolute).split(path.sep).join('/') },
              region: {
                startLine: physical.region?.startLine,
                startColumn: physical.region?.startColumn,
              },
            },
          };
        }),
      })),
    })),
  };
}

// Never parse an execution failure as zero vulnerabilities, or print raw scanner
// output (which can contain source snippets or authentication diagnostics).
function classify(result, exitCode, kind) {
  if (![0, 1].includes(exitCode)) return { status: 'unavailable', exitCode: 2 };
  if (
    !result ||
    result.error ||
    result.errors ||
    (result.ok === false && !result.vulnerabilities)
  ) {
    return { status: 'unavailable', exitCode: 2 };
  }
  let count;
  if (kind === 'code') {
    if (
      !Array.isArray(result.runs) ||
      result.runs.length === 0 ||
      result.runs.some(
        run =>
          !Array.isArray(run.results) || run.invocations?.some(i => i.executionSuccessful === false)
      )
    ) {
      return { status: 'unavailable', exitCode: 2 };
    }
    count = result.runs.reduce((sum, run) => sum + run.results.length, 0);
  } else {
    if (!Array.isArray(result.vulnerabilities)) return { status: 'unavailable', exitCode: 2 };
    count = result.vulnerabilities.length;
  }
  if ((exitCode === 1) !== count > 0) return { status: 'unavailable', exitCode: 2 };
  let findings;
  if (count && kind === 'dependencies') {
    findings = [
      ...new Map(
        result.vulnerabilities.map(item => [
          `${item.id || 'unknown'}:${item.packageName || 'unknown'}`,
          {
            id: item.id || 'unknown',
            package: item.packageName || 'unknown',
            severity: item.severity || 'unknown',
          },
        ])
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id) || a.package.localeCompare(b.package));
  } else if (count && kind === 'code') {
    const root = path.resolve(__dirname, '..');
    findings = [
      ...new Map(
        result.runs.flatMap(run =>
          run.results.map(item => {
            const physical = item.locations?.[0]?.physicalLocation || {};
            const uri = physical.artifactLocation?.uri || '';
            const absolute = uri.startsWith('file:') ? new URL(uri).pathname : path.resolve(uri);
            const finding = {
              id: item.ruleId || 'unknown',
              path: path.relative(root, absolute).split(path.sep).join('/'),
              line: physical.region?.startLine,
            };
            return [`${finding.id}:${finding.path}:${finding.line || 0}`, finding];
          })
        )
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }
  return {
    status: count ? 'findings' : 'clean',
    count,
    ...(findings ? { findings } : {}),
    exitCode: count ? 1 : 0,
  };
}

if (require.main === module) {
  const kind = process.argv[2];
  if (!['code', 'dependencies'].includes(kind)) process.exit(2);
  const args = kind === 'code' ? ['code', 'test', '--sarif'] : ['test', '--json'];
  const run = spawnSync('snyk', [...args, '--severity-threshold=high', ...process.argv.slice(3)], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    /* A non-JSON result is unavailable. */
  }
  const summary = classify(parsed, run.status, kind);
  if (kind === 'code' && summary.status !== 'unavailable' && process.env.SNYK_SARIF_OUTPUT) {
    // Strip source snippets, raw diagnostic messages and fix content before upload.
    fs.writeFileSync(process.env.SNYK_SARIF_OUTPUT, JSON.stringify(safeSarif(parsed)));
  }
  console.log(JSON.stringify({ kind, ...summary }));
  process.exit(summary.exitCode);
}
module.exports = { classify, safeSarif };
