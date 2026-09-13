#!/usr/bin/env node
// Checks high-confidence error-to-output flows, including local aliases. This is
// a regression guard, not a substitute for reviewing new error serializers.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function scanSources(sources) {
  const options = {
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file, languageVersion) =>
    sources[file] === undefined
      ? undefined
      : ts.createSourceFile(file, sources[file], languageVersion, true);
  const program = ts.createProgram(Object.keys(sources), options, host);
  const checker = program.getTypeChecker();
  const findings = [];
  const assignments = new Map();
  for (const file of Object.keys(sources)) {
    function collectAssignments(node) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) assignments.set(symbol, [...(assignments.get(symbol) || []), node.right]);
      }
      ts.forEachChild(node, collectAssignments);
    }
    collectAssignments(program.getSourceFile(file));
  }
  function untrusted(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return untrusted(node.expression, seen);
    if (ts.isConditionalExpression(node))
      return untrusted(node.whenTrue, seen) || untrusted(node.whenFalse, seen);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations || [];
      if ((assignments.get(symbol) || []).some(value => untrusted(value, seen))) return true;
      return declarations.some(
        d => ts.isVariableDeclaration(d) && d.initializer && untrusted(d.initializer, seen)
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const text = node.getText();
      // Moderation explanations are intentional public content from User.ban_reason.
      if (/\.ban_reason$/.test(text)) return false;
      // Identify diagnostics structurally, including bracket access and catch
      // variables with names other than "err".
      let root = node;
      const fields = [];
      while (
        ts.isPropertyAccessExpression(root) ||
        ts.isElementAccessExpression(root) ||
        ts.isParenthesizedExpression(root) ||
        ts.isAsExpression(root)
      ) {
        if (ts.isPropertyAccessExpression(root)) fields.push(root.name.text);
        if (
          ts.isElementAccessExpression(root) &&
          root.argumentExpression &&
          ts.isStringLiteral(root.argumentExpression)
        )
          fields.push(root.argumentExpression.text);
        root = root.expression;
      }
      if (ts.isIdentifier(root)) {
        const declarations = checker.getSymbolAtLocation(root)?.declarations || [];
        const caught = declarations.some(
          d => ts.isVariableDeclaration(d) && ts.isCatchClause(d.parent)
        );
        if (
          (caught || /^(e|err|error|\w*Error)$/.test(root.text)) &&
          fields.some(field => /^(data|response|body|message|stack|error)$/.test(field))
        )
          return true;
      }
      return untrusted(node.expression, seen);
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText();
      if (/^(toUserMessage|toAuthErrorMessage|sanitizeMessage|apiErrorMessage)$/.test(name))
        return untrusted(node.arguments[1], seen);
      // These conversions return booleans/numbers, never the source text.
      if (
        /\.(includes|startsWith|endsWith|test|toFixed|toLocaleDateString|toLocaleTimeString)$/.test(
          name
        )
      )
        return false;
      if (name === 'String' || name === 'JSON.stringify')
        return node.arguments.some(a => untrusted(a, seen));
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        /^(trim|toLowerCase|toUpperCase|slice|substring|join)$/.test(node.expression.name.text)
      )
        return untrusted(node.expression.expression, seen);
      return false;
    }
    if (ts.isBinaryExpression(node)) {
      if (
        [
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.PlusToken,
        ].includes(node.operatorToken.kind)
      )
        return untrusted(node.left, seen) || untrusted(node.right, seen);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return untrusted(node.right, seen);
      return false;
    }
    if (ts.isTemplateExpression(node))
      return node.templateSpans.some(span => untrusted(span.expression, seen));
    if (ts.isObjectLiteralExpression(node))
      return node.properties.some(p =>
        ts.isPropertyAssignment(p)
          ? untrusted(p.initializer, seen)
          : ts.isShorthandPropertyAssignment(p)
            ? untrusted(p.name, seen)
            : false
      );
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(e => untrusted(e, seen));
    return false;
  }
  function requiresDev(node) {
    if (ts.isIdentifier(node)) return node.text === '__DEV__';
    if (ts.isParenthesizedExpression(node)) return requiresDev(node.expression);
    return (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      (requiresDev(node.left) || requiresDev(node.right))
    );
  }
  for (const file of Object.keys(sources)) {
    const source = program.getSourceFile(file);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        let values = [];
        if (name === 'Alert.alert') values = [...node.arguments].slice(0, 2);
        else if (/^(set(?:\w*Error|Error\w*)|showErrorToast|showToast)$/.test(name))
          values = [node.arguments[0]];
        else if (
          /^set\w*Modal$/.test(name) &&
          ts.isObjectLiteralExpression(node.arguments[0] || {})
        )
          values = node.arguments[0].properties
            .filter(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'message')
            .map(p => p.initializer);
        else if (file.startsWith('server/') && name === 'sendError')
          values = [...node.arguments].slice(2);
        else if (
          file.startsWith('server/') &&
          /^res(?:\.|\[)/.test(name) &&
          /\.(json|send)$/.test(name)
        )
          values = [node.arguments[0]];
        else if (/^(toUserMessage|toAuthErrorMessage|sanitizeMessage)$/.test(name))
          values = [node.arguments[1]];
        if (values.some(value => untrusted(value)))
          findings.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sink: name,
          });
      }
      if (ts.isJsxExpression(node) && node.expression && untrusted(node.expression)) {
        let devOnly = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (
            ts.isConditionalExpression(parent) &&
            requiresDev(parent.condition) &&
            node.pos >= parent.whenTrue.pos &&
            node.end <= parent.whenTrue.end
          )
            devOnly = true;
          if (
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            requiresDev(parent.left)
          )
            devOnly = true;
        }
        if (!devOnly)
          findings.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sink: 'JSX',
          });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return findings;
}
function collect(root, sources = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !['__tests__', 'node_modules', 'dist'].includes(entry.name))
      collect(file, sources);
    else if (
      entry.isFile() &&
      /\.tsx?$/.test(file) &&
      !/(?:TestApp|testApp|\.test|\.spec)\./.test(file)
    )
      sources[file] = fs.readFileSync(file, 'utf8');
  }
  return sources;
}
if (require.main === module) {
  const sources = {};
  for (const root of [
    'app',
    'components',
    'hooks',
    'utils',
    'context',
    'lib',
    'apiclient',
    'config',
    'shared',
    'server/src',
  ])
    collect(root, sources);
  const findings = scanSources(sources);
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: raw error reaches ${finding.sink}`);
  console.log(
    `[error-disclosure] ${Object.keys(sources).length} files checked; ${findings.length} unsafe output flows.`
  );
  process.exitCode = findings.length ? 1 : 0;
}
module.exports = { scanSources };
