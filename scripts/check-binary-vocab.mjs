// Binary-control containment guard for the planner / executor layers.
//
// WHY THIS EXISTS: the planner (`lib/plan`) and executor (`lib/executor`) must
// NEVER read a device's observed `binaryControl.on` directly. Doing so forces
// each call site to re-decide what an absent `binaryControl` means (a non-binary
// device, or one before its first observation) — the `?? true` / `=== false`
// scatter that the shared-domain consolidation removed. Every reading must go
// through the producer-resolved shared-domain readers in
// `packages/shared-domain/src/binaryControlState.ts`:
//   - `isBinaryOnOrUnknown`  (absent → on / "may draw")
//   - `isBinaryObservedOff`  (only CONFIRMED observed-off)
//   - `getObservedBinaryOn`  (boolean | null; preserves "non-binary")
//
// Forwarding the whole struct (`binaryControl: device.binaryControl`) is
// plumbing, not a reading, and stays allowed — only `.on` access on a
// `binaryControl` receiver is forbidden here. The raw field legitimately lives
// in the transport producer (`lib/device/**`) and in shared-domain (the readers
// themselves), neither of which this guard scans.
//
// Implementation uses the TypeScript compiler API (not a raw-text regex) so that
// comments and doc-strings mentioning `binaryControl.on` never false-positive —
// only an actual `.on` access on a `binaryControl` receiver is flagged. It
// catches property access, element access, and `const { on } = <binaryControl>`
// destructuring. Like every syntactic sibling guard it cannot follow a renamed
// local alias (`const bc = x.binaryControl; bc.on`) — that needs the type
// checker; the readers being the only sanctioned path makes such an alias an
// obvious review smell.
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

// True when `node` is a reference to a `binaryControl` member — either
// `x.binaryControl` (property access) or a bare `binaryControl` identifier
// (e.g. after destructuring). Optional-chained access shares the same node kind.
function isBinaryControlReceiver(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'binaryControl';
  if (ts.isIdentifier(node)) return node.text === 'binaryControl';
  return false;
}

// True when an object-binding-pattern destructures `on` out of its target —
// `const { on } = <binaryControl>` (matched against the declaration initializer
// by the caller). `on` is too common a leaf to ban everywhere (steppedLoad.on,
// action.current.on …), so this is gated on the initializer being a
// binaryControl receiver, unlike the unique-leaf `controlModel` guard.
function destructuresOn(bindingPattern) {
  return bindingPattern.elements.some((el) => {
    const prop = el.propertyName ?? el.name;
    return ts.isIdentifier(prop) && prop.text === 'on';
  });
}

function collectOffenders(sourceFile, relPath, offenders) {
  const flag = (node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    offenders.push({ file: relPath, line: line + 1 });
  };
  const visit = (node) => {
    // Flag `<binaryControl>.on` and `<binaryControl>?.on`.
    if (ts.isPropertyAccessExpression(node)
      && node.name.text === 'on'
      && isBinaryControlReceiver(node.expression)) {
      flag(node);
    }
    // Flag `<binaryControl>['on']` element access too.
    if (ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'on'
      && isBinaryControlReceiver(node.expression)) {
      flag(node);
    }
    // Flag `const { on } = <binaryControl>` destructuring of the leaf.
    if (ts.isVariableDeclaration(node)
      && node.initializer !== undefined
      && isBinaryControlReceiver(node.initializer)
      && ts.isObjectBindingPattern(node.name)
      && destructuresOn(node.name)) {
      flag(node.name);
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
    'Binary-control containment violation (check-binary-vocab):\n'
    + 'lib/plan/** and lib/executor/** must not read `binaryControl.on` directly.\n'
    + 'Use the shared-domain readers (isBinaryOnOrUnknown, isBinaryObservedOff,\n'
    + 'getObservedBinaryOn) so absence-handling stays in one place. Forwarding the\n'
    + 'struct (`binaryControl: x.binaryControl`) is fine; reading `.on` is not.\n'
    + 'Offending access(es):\n',
  );
  for (const { file, line } of offenders) {
    process.stderr.write(`  ${file}:${line}  binaryControl.on\n`);
  }
  process.exit(1);
}

process.stdout.write(`binary:vocab OK — no raw binaryControl.on reads in plan/executor (${files.length} files scanned)\n`);
