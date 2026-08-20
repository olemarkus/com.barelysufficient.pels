// Settle-seam containment guard for the plan-to-plan convergence predicate.
//
// WHY THIS EXISTS: `hasLiveStateDivergedFromSnapshot` compares two `DevicePlan`s
// positionally by array index, and its live side is always `buildLiveStatePlan`
// output — "by construction the OLD decision seen freshly … for publishing
// snapshots, never for deciding to actuate" (`lib/plan/AGENTS.md`). Consulting it
// from an actuation decision would be an apply-without-decide path, the exact
// shape that let a re-assert outrun the planner's admission gate and breach the
// hard cap in production (`TODO.md`, inc_26449fb9).
//
// It is reachable today from exactly one place — `canRefreshPlanSnapshotFromLiveState`
// in the same module, a SETTLE question whose callers only adopt a refreshed
// snapshot and emit `planUpdated`. This guard locks that in: across all runtime
// code, the ONLY references permitted are its declaration and the call from
// that one function. The question "does the executor have work to do?" has one
// answer,
// `hasPlanExecutionDriftAgainstIntent`, which compares intent against an
// observation instead of against another plan.
//
// Tests may reference the predicate directly (they pin its semantics), so
// `test/**` is out of scope — as it is for the sibling guards.
//
// The owner module is scanned too, not skipped. Skipping it would leave the one
// file where a bypass is most plausible unchecked — a future actuation helper
// added beside the predicate would call it with CI silent, which is exactly the
// invariant this guard exists to hold. Inside the owner, precisely two
// occurrences are allowed: the function's own declaration, and references from
// the body of `canRefreshPlanSnapshotFromLiveState`. A top-level alias or
// re-export (`export const hasSnapshotDrift = hasLiveStateDivergedFromSnapshot`)
// is in neither position, so it is flagged.
//
// Detection is AST-based (not a raw-text regex) so comments and doc-strings that
// name the predicate never false-positive — only real identifier references in
// code are flagged. Like every syntactic sibling guard it cannot see through a
// string-keyed element access (`mod['hasLiveState…']`); that needs the type
// checker, and it is an obvious review smell against a predicate with one
// legitimate caller.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanDirs = ['lib', 'setup', 'flowCards', 'drivers'].map((d) => path.join(rootDir, d));
// The two runtime entry points live at the repo root, outside every scan dir.
// Omitting them would leave the guard's "runtime code" claim wider than its reach.
const scanFiles = ['app.ts', 'api.ts'].map((f) => path.join(rootDir, f));
const ownerFile = path.join(rootDir, 'lib/executor/executorConvergence.ts');

const FORBIDDEN_SYMBOL = 'hasLiveStateDivergedFromSnapshot';
// The one function inside the owner module allowed to call it — the settle
// question the predicate is a precondition of.
const OWNER_ALLOWED_CALLER = 'canRefreshPlanSnapshotFromLiveState';

// The name of the function whose body `node` sits in, or undefined at top level.
// Covers both `function f() {}` and `const f = () => {}` so a later refactor of
// the allowed caller does not turn its legitimate call into an offender.
function enclosingFunctionName(node, current) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return current;
}

// The identifier IS the predicate's own `function hasLiveStateDivergedFromSnapshot`
// declaration name — the one occurrence that must exist.
function isOwnDeclarationName(node) {
  return node.parent !== undefined
    && ts.isFunctionDeclaration(node.parent)
    && node.parent.name === node;
}

function collectOffenders(sourceFile, relPath, offenders, isOwner) {
  const visit = (node, enclosing) => {
    const scope = enclosingFunctionName(node, enclosing);
    if (ts.isIdentifier(node) && node.text === FORBIDDEN_SYMBOL) {
      const allowed = isOwner && (isOwnDeclarationName(node) || scope === OWNER_ALLOWED_CALLER);
      if (!allowed) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        offenders.push({ file: relPath, line: line + 1 });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sourceFile, undefined);
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

const files = [...(await Promise.all(scanDirs.map(collectTsFiles))).flat(), ...scanFiles];
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders, file === ownerFile);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Settle-seam violation (check-executor-settle-seam):\n'
    + `${FORBIDDEN_SYMBOL} compares two DevicePlans positionally against a live\n`
    + 'merge that re-carries the OLD decision. It is a precondition of the settle\n'
    + 'question (canRefreshPlanSnapshotFromLiveState) and nothing else — no\n'
    + 'actuation decision may consult it. Ask hasPlanExecutionDriftAgainstIntent\n'
    + 'instead: it compares planner intent against an observation.\n'
    + 'Offending reference(s):\n',
  );
  for (const { file, line } of offenders) {
    process.stderr.write(`  ${file}:${line}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `executor:settle-seam OK — the plan-to-plan predicate stays inside its module (${files.length} files scanned)\n`,
);
