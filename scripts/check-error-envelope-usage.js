#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

// Check the complete working tree for disclosure regressions as well as envelope shape.
execFileSync(
  process.execPath,
  [require('node:path').join(__dirname, 'check-error-disclosure.cjs')],
  { stdio: 'inherit' }
);

function resolveBaseSha() {
  const explicitBaseSha = process.env.GIT_BASE_SHA || process.argv[2];
  if (explicitBaseSha) return explicitBaseSha;

  try {
    return execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
  } catch {
    const message =
      '[error-guard] No base SHA provided. Set GIT_BASE_SHA or run from a git checkout with at least two commits.';
    if (process.env.ALLOW_GUARD_SKIP === '1') {
      console.warn(`${message} Skipping because ALLOW_GUARD_SKIP=1.`);
      process.exit(0);
    }
    console.error(message);
    process.exit(1);
  }
}

const baseSha = resolveBaseSha();
const headSha = process.env.GIT_HEAD_SHA || process.argv[3] || 'HEAD';

const exemptToken = 'error-envelope-exempt';
const allowedPaths = new Set(['server/src/lib/http/sendError.ts']);

// Cache of base-SHA file contents to detect reformatted (pre-existing) violations
const baseFileCache = new Map();
function getBaseFileContent(filePath) {
  if (baseFileCache.has(filePath)) return baseFileCache.get(filePath);
  try {
    const content = execFileSync('git', ['show', `${baseSha}:${filePath}`], { encoding: 'utf8' });
    baseFileCache.set(filePath, content);
    return content;
  } catch {
    baseFileCache.set(filePath, null);
    return null;
  }
}

function isDiffOnlyReformat(filePath, snippet) {
  const baseContent = getBaseFileContent(filePath);
  if (!baseContent) return false;
  // Normalize whitespace for comparison: collapse all whitespace runs to single space
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const normalized = normalize(snippet);
  // Check if the same normalized snippet exists anywhere in the base file
  const baseNormalized = normalize(baseContent);
  if (baseNormalized.includes(normalized)) return true;
  // Fallback: check if all meaningful tokens from the snippet exist in the base
  // (handles prettier adding/removing trailing commas which changes normalized form)
  const errorMatch = snippet.match(/error\s*:\s*['"`]([^'"`]+)['"`]/);
  if (errorMatch) {
    return baseContent.includes(errorMatch[1]);
  }
  return false;
}

function getDiff() {
  const args = ['diff', '--unified=0', '--no-color', baseSha];
  if (headSha !== 'WORKTREE') {
    args.push(headSha);
  }
  args.push('--', ':(glob)server/src/**/*.ts');

  try {
    return execFileSync('git', args, { encoding: 'utf8' });
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : '';
    if (stdout) return stdout;
    throw error;
  }
}

function maybeRecordViolation(state, findings) {
  if (!state.currentFile || allowedPaths.has(state.currentFile) || state.exempt) {
    return;
  }

  const snippet = state.buffer.join(' ').trim();
  if (!/res(?:\.status\([^)]*\))?\.json\s*\(/.test(snippet)) return;
  if (!/\berror\s*:/.test(snippet)) return;
  if (/\bsendError\s*\(/.test(snippet)) return;

  // Skip violations that are pre-existing in the base SHA (only whitespace/formatting changed)
  if (isDiffOnlyReformat(state.currentFile, snippet)) return;

  findings.push({
    file: state.currentFile,
    snippet,
  });
}

const diff = getDiff();
if (!diff.trim()) {
  console.log('[error-guard] No server changes detected.');
  process.exit(0);
}

const findings = [];
const state = {
  currentFile: null,
  collecting: false,
  exempt: false,
  buffer: [],
};

for (const line of diff.split('\n')) {
  if (line.startsWith('diff --git ')) {
    maybeRecordViolation(state, findings);
    state.currentFile = null;
    state.collecting = false;
    state.exempt = false;
    state.buffer = [];
    continue;
  }

  if (line.startsWith('+++ b/')) {
    state.currentFile = line.slice(6);
    continue;
  }

  if (!state.currentFile) continue;
  if (state.currentFile.includes('/__tests__/')) continue;

  if (line.startsWith('@@')) {
    maybeRecordViolation(state, findings);
    state.collecting = false;
    state.exempt = false;
    state.buffer = [];
    continue;
  }

  if (!line.startsWith('+') || line.startsWith('+++')) {
    continue;
  }

  const addedLine = line.slice(1);

  if (!state.collecting && /\bres(?:\.status\([^)]*\))?\.json\s*\(/.test(addedLine)) {
    state.collecting = true;
    state.exempt = addedLine.includes(exemptToken);
    state.buffer = [addedLine];

    if (/\)\s*;?\s*$/.test(addedLine)) {
      maybeRecordViolation(state, findings);
      state.collecting = false;
      state.exempt = false;
      state.buffer = [];
    }
    continue;
  }

  if (!state.collecting) continue;

  state.buffer.push(addedLine);
  if (addedLine.includes(exemptToken)) state.exempt = true;

  if (/\)\s*;?\s*$/.test(addedLine)) {
    maybeRecordViolation(state, findings);
    state.collecting = false;
    state.exempt = false;
    state.buffer = [];
  }
}

maybeRecordViolation(state, findings);

if (findings.length > 0) {
  console.error('\n[error-guard] New error responses must use sendError().');
  console.error(
    '[error-guard] Replace raw res.status(...).json({ error: ... }) with sendError(...) or add // error-envelope-exempt.'
  );
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.snippet}`);
  }
  process.exit(1);
}

console.log('[error-guard] No new raw error envelope violations found.');
