// Device-KIND vocabulary containment guard for the planner / observer /
// objectives / executor layers (sibling of check-ev-vocab.mjs, which covers EV
// plug-state).
//
// SCOPE: `lib/plan`, `lib/observer`, `lib/objectives`, and `lib/executor`.
// (Objectives' EV / temperature power-fallbacks were de-kinded to shared-domain
// predicates; only genuine `objectiveKind` branches — an objective's own kind,
// not a device's — remain there, which this guard does not touch.)
//
// It enforces TWO related containments. Rules 1-2 keep device KIND out of these
// layers entirely. Rule 3 is narrower and its opposite in spirit: control
// MODALITY (binary / stepped) is exactly what these layers may branch on, but
// only through the ONE predicate that defines it — never by re-inlining the
// discriminant field test. The binary axis is why the rule exists: because
// `controlCapabilityId === undefined` reads as ordinary absence-handling rather
// than as classification, it drifted into nine call sites while the stepped axis
// beside it was migrating through `isSteppedLoadDevice` at 118 of them.
//
// WHY THIS EXISTS: these layers must branch on CONTROL MODALITY
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
// Rule 3 additionally matches a truthiness read of the binary discriminant —
// `!x.controlCapabilityId`, `if (x.controlCapabilityId)`, `Boolean(...)`, and the
// control operand of a standalone `x.controlCapabilityId && …` guard — because the
// comparison form failing the build is otherwise just a lesson in which spelling
// evades it; two executor branches were already written that way.
//
// Like check-ev-vocab, this is a tripwire for the obvious/copy-pasted patterns,
// not a sandbox: it will not catch a branch laundered through an intermediate
// variable (`const dt = d.deviceType; if (dt === 'temperature')`), a method-call
// chain (`d.deviceType?.toLowerCase() === ...`), a destructure-then-compare, or
// exotica like `typeof x.controlCapabilityId === 'string'` / loose `== null`.
// Those are review-caught.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumerDirs = ['lib/plan', 'lib/observer', 'lib/objectives', 'lib/executor'].map((d) => path.join(rootDir, d));

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

// Rule 3: control-MODALITY discriminants. Each is a real field test these layers
// must not spell out, paired with the predicate that owns it. `model` is matched
// as an exact property name, so the producer-only `controlModel` setting (a
// different question — not the stepped discriminant) does not trip this.
const MODALITY_DISCRIMINANTS = [
  {
    prop: 'controlCapabilityId',
    literal: undefined, // compared against `undefined`/`null`, not a string
    predicate: 'hasBinaryControlCapability (shared-domain) / isBinaryPlanDevice (lib/plan)',
  },
  {
    prop: 'model',
    literal: 'stepped_load',
    predicate: 'isSteppedLoadSnapshot (shared-domain) / isSteppedLoadDevice (lib/plan)',
  },
];

// `undefined` / `null` as a comparison operand, seen through the same wrappers.
function isNullishOperand(node) {
  const n = unwrap(node);
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isIdentifier(n) && n.text === 'undefined';
}

// Discriminants whose truthiness answers the same question as their nullish
// comparison, so a boolean-context read is the same classification spelled
// differently. `controlCapabilityId` is the whole set: its type is a union of
// non-empty literals, so `!x.controlCapabilityId` and `x.controlCapabilityId ===
// undefined` agree, and the first is exactly what a future author reaches for
// when the comparison form fails the build. `steppedLoadProfile` is deliberately
// NOT here — its truthiness is mere presence, a genuinely different question from
// `model === 'stepped_load'`, and presence checks inside already-narrowed helpers
// are legitimate.
const TRUTHINESS_DISCRIMINANTS = new Map([
  ['controlCapabilityId', 'hasBinaryControlCapability (shared-domain) / isBinaryPlanDevice (lib/plan)'],
]);

/**
 * Report every discriminant read that is used directly as a boolean. `expr` is
 * an expression already known to sit in a boolean context; recursion carries
 * that context down through the operators that preserve it — `!`, parentheses,
 * and `&&`/`||` — so `if (!a.controlCapabilityId || b)` is caught at the leaf.
 *
 * `??` is deliberately not recursed into: `x.controlCapabilityId ?? 'onoff'` is a
 * defaulting read, not a classification, and flagging it would push authors into
 * a worse shape rather than toward the predicate.
 */
function collectTruthinessReads(expr, sourceFile, relPath, out) {
  const n = unwrap(expr);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
    collectTruthinessReads(n.operand, sourceFile, relPath, out);
    return;
  }
  if (
    ts.isBinaryExpression(n)
    && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    collectTruthinessReads(n.left, sourceFile, relPath, out);
    collectTruthinessReads(n.right, sourceFile, relPath, out);
    return;
  }
  const prop = accessedPropName(n);
  const predicate = prop === null ? undefined : TRUTHINESS_DISCRIMINANTS.get(prop);
  if (predicate === undefined) return;
  const { line } = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile));
  out.push({
    file: relPath,
    line: line + 1,
    detail: `\`${prop}\` read as a boolean — call ${predicate}`,
  });
}

/** The expression a node evaluates for truthiness, or null if it has none. */
function booleanContextExpression(node) {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return node.expression;
  }
  if (ts.isConditionalExpression(node)) return node.condition;
  if (ts.isForStatement(node)) return node.condition ?? null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return node.operand;
  }
  // `Boolean(x.controlCapabilityId)` — the other spelling within easy reach.
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(unwrap(node.expression))
    && unwrap(node.expression).text === 'Boolean'
    && node.arguments.length === 1
  ) {
    return node.arguments[0];
  }
  return null;
}

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

function collectOffenders(sourceFile, relPath, offenders, modalityOffenders) {
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
      // (3a) an inlined control-modality discriminant, as a nullish/literal comparison
      for (const { prop, literal, predicate } of MODALITY_DISCRIMINANTS) {
        const side = leftProp === prop ? node.right : (rightProp === prop ? node.left : null);
        if (side === null) continue;
        const matches = literal === undefined
          ? isNullishOperand(side)
          : literalText(side) === literal;
        if (!matches) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        modalityOffenders.push({
          file: relPath,
          line: line + 1,
          detail: `inlined \`${prop}\` discriminant — call ${predicate}`,
        });
      }
    }
    // (3b) the same discriminant spelled as truthiness. Without this, `===
    // undefined` failing the build simply teaches the next author to write `!x`.
    const condition = booleanContextExpression(node);
    if (condition !== null) {
      collectTruthinessReads(condition, sourceFile, relPath, modalityOffenders);
    }
    // (3c) a standalone short-circuit guard — `const x = d.controlCapabilityId && f()`
    // — where no enclosing `if`/`!` supplies the boolean context. Only the LEFT
    // operand, and only for `&&`: that is the control operand, the one being
    // tested. `||`'s left operand is a value being defaulted from (the `??` case
    // by another name), so flagging it would push authors away from the predicate
    // rather than toward it. In a real boolean context both operands are already
    // reached by the recursion above.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectTruthinessReads(node.left, sourceFile, relPath, modalityOffenders);
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
// Nested boolean contexts visit the same leaf more than once (an `if` whose
// condition is a `!` is two contexts over one read), so report by site.
const modalityOffendersByKey = new Map();
const modalityOffenders = {
  push(offender) {
    modalityOffendersByKey.set(`${offender.file}:${offender.line}:${offender.detail}`, offender);
  },
  get length() { return modalityOffendersByKey.size; },
  [Symbol.iterator]() { return modalityOffendersByKey.values(); },
};

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders, modalityOffenders);
}

if (modalityOffenders.length > 0) {
  process.stderr.write(
    'Control-modality predicate containment violation (check-device-kind-vocab):\n'
    + 'The binary and stepped discriminants have exactly one runtime definition each,\n'
    + 'in packages/shared-domain/**. Consumer layers ask through the predicate; they do\n'
    + 'not re-spell the field test, because a second spelling can drift from the first\n'
    + 'and reads as absence-handling rather than as classification. Rewriting the site\n'
    + 'into a spelling this tripwire does not match is not the fix.\n'
    + 'Offending site(s):\n',
  );
  for (const { file, line, detail } of modalityOffenders) {
    process.stderr.write(`  ${file}:${line}  ${detail}\n`);
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    'Device-kind vocabulary containment violation (check-device-kind-vocab):\n'
    + 'lib/plan/**, lib/objectives/** and lib/executor/** must not branch on device\n'
    + 'KIND (deviceClass family names or the deviceType discriminant). Use the\n'
    + 'shared-domain predicates (isEvDevice, isTemperatureControlDevice,\n'
    + 'isStarvationSupportedDeviceClass) or producer-resolved bits instead. Kind\n'
    + 'vocabulary lives only in lib/device/** (transport) and packages/shared-domain/**.\n'
    + 'Offending site(s):\n',
  );
  for (const { file, line, detail } of offenders) {
    process.stderr.write(`  ${file}:${line}  ${detail}\n`);
  }
}

if (offenders.length > 0 || modalityOffenders.length > 0) {
  process.exit(1);
}

process.stdout.write(
  'device-kind:vocab OK — no deviceClass/deviceType kind branches and no inlined '
  + `binary/stepped discriminants in plan/observer/objectives/executor (${files.length} files scanned)\n`,
);
