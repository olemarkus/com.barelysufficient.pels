// Device-KIND vocabulary containment guard for the planner / executor layers
// (sibling of check-ev-vocab.mjs, which covers EV plug-state).
//
// SCOPE: `lib/plan` and `lib/executor` today. `lib/objectives` still has device-
// kind branches (deviceClass === 'evcharger' / deviceType === 'temperature' power
// fallbacks in samples.ts / objectiveSteps.ts / planningSpeed.ts); de-kinding
// those needs per-site judgment (isEvDevice widens the EV check; objective-kind
// vs device-kind), tracked as a T2 follow-up in TODO.md. Add lib/objectives to
// consumerDirs once those sites read shared-domain predicates.
//
// WHY THIS EXISTS: `lib/plan` and `lib/executor` must branch on CONTROL MODALITY
// (binary / target / stepped) and producer-resolved bits — never on device KIND.
// The two kind axes that leak are:
//   - `deviceClass` family names ('thermostat'/'heater'/'heatpump'/
//     'airconditioning'/'airtreatment'/'evcharger'), and
//   - the `deviceType` discriminant ('temperature'/'onoff').
// Inlining either re-introduces the kind-coupling we keep pushing down to the
// producer. The kind vocabulary legitimately lives ONLY in the transport
// producer (`lib/device/**`) and the browser-safe predicates in
// `packages/shared-domain/**` (e.g. `isEvDevice`, `isTemperatureControlDevice`,
// `isStarvationSupportedDeviceClass`); consumers call those predicates.
//
// Detection is AST-based (not raw regex) and deliberately NARROW so legitimate
// capability ids ('onoff' as a controlCapabilityId, 'target_temperature' as a
// write target) and copy strings never false-positive:
//   1. bare device-CLASS family-name string literals, and
//   2. `===`/`!==` comparisons where one operand is a `.deviceType` / `.deviceClass`
//      property access (seen through parens / `as` / non-null / `satisfies`
//      wrappers) and the other is a string literal (any value).
// Like check-ev-vocab, this is a tripwire for the obvious/copy-pasted patterns,
// not a sandbox: it will not catch a kind branch laundered through an intermediate
// variable (`const dt = d.deviceType; if (dt === 'temperature')`) or a method-call
// chain (`d.deviceType?.toLowerCase() === ...`). Those are review-caught.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumerDirs = ['lib/plan', 'lib/executor'].map((d) => path.join(rootDir, d));

// Device-CLASS family names. These are device kinds the consumer layers must not
// name; a thermostat, heat pump, etc. is identified abstractly via shared-domain
// predicates. `evcharger` is included for symmetry (EV identity goes through
// `isEvDevice`). NOT a capability id and NOT a control modality.
const FORBIDDEN_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'heatpump',
  'airconditioning',
  'airtreatment',
  'evcharger',
]);

// Property names whose comparison against a string literal is a kind branch.
const KIND_DISCRIMINANT_PROPS = new Set(['deviceType', 'deviceClass']);

// Peel wrappers that don't change the underlying value/expression so the
// matchers below see through `(x)`, `x as T`, `<T>x`, `x!`, and `x satisfies T`.
// Keeps the guard from being trivially bypassed by an inline cast/parenthesis.
// Uses only the public, documented `ts.isParenthesizedExpression` API (not the
// internal `ts.skipParentheses`) so a TypeScript upgrade can't break the guard.
function skipParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function unwrap(node) {
  let current = skipParentheses(node);
  for (;;) {
    if (
      ts.isAsExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression?.(current)
      || (ts.isSatisfiesExpression?.(current))
    ) {
      current = skipParentheses(current.expression);
      continue;
    }
    return current;
  }
}

function literalText(node) {
  const n = unwrap(node);
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

function accessedPropName(node) {
  const n = unwrap(node);
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  // `x['deviceType']`
  if (ts.isElementAccessExpression(n)) return literalText(n.argumentExpression);
  return null;
}

function collectOffenders(sourceFile, relPath, offenders) {
  const visit = (node) => {
    // (1) bare device-class family-name literals
    const text = literalText(node);
    if (text !== null && FORBIDDEN_DEVICE_CLASSES.has(text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, detail: `device-class literal '${text}'` });
    }
    // (2) `.deviceType`/`.deviceClass` compared to a string literal
    if (
      ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const leftProp = accessedPropName(node.left);
      const rightProp = accessedPropName(node.right);
      const leftLit = literalText(node.right);
      const rightLit = literalText(node.left);
      if (leftProp && KIND_DISCRIMINANT_PROPS.has(leftProp) && leftLit !== null) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        offenders.push({ file: relPath, line: line + 1, detail: `${leftProp} compared to '${leftLit}'` });
      } else if (rightProp && KIND_DISCRIMINANT_PROPS.has(rightProp) && rightLit !== null) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        offenders.push({ file: relPath, line: line + 1, detail: `${rightProp} compared to '${rightLit}'` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

async function collectTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(full);
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return [full];
    }),
  );
  return files.flat();
}

const fileLists = await Promise.all(consumerDirs.map((dir) => collectTsFiles(dir)));
const files = fileLists.flat();
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Device-kind vocabulary containment violation (check-device-kind-vocab):\n'
    + 'lib/plan/** and lib/executor/** must not branch on device\n'
    + 'KIND (deviceClass family names or the deviceType discriminant). Use the\n'
    + 'shared-domain predicates (isEvDevice, isTemperatureControlDevice,\n'
    + 'isStarvationSupportedDeviceClass) or producer-resolved bits instead. Kind\n'
    + 'vocabulary lives only in lib/device/** (transport) and packages/shared-domain/**.\n'
    + 'Offending site(s):\n',
  );
  for (const { file, line, detail } of offenders) {
    process.stderr.write(`  ${file}:${line}  ${detail}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `device-kind:vocab OK — no deviceClass/deviceType kind branches in plan/executor (${files.length} files scanned)\n`,
);
