// AST guard + ratchet for the executor -> planner source-level boundary.
//
// WHY THIS EXISTS: the plan -> executor direction has been enforced for a while
// (`no-plan-to-executor` plus scripts/check-plan-objectives-edge.mjs). The
// REVERSE direction had no rule at all, and that is where the coupling actually
// accumulated: 24 files under lib/executor/ importing 13 distinct lib/plan
// modules, including planner decisions the executor then re-derives.
//
// The target state is zero edges: the planner emits a total action contract and
// the executor consumes only that (see the planner/executor seam train). Until
// then this guard is a RATCHET, not a ban — every edge that exists today is
// listed in ALLOWED below, and the guard fails on two things:
//
//   1. a NEW edge that is not in the allowlist, and
//   2. a STALE allowlist entry — one listed here that the code no longer has.
//
// (2) is the half that makes this a ratchet rather than a snapshot. Without it,
// a later stage deletes an edge, nobody removes the entry, and the edge can be
// silently re-added months later with CI green. Deleting an edge is therefore
// required to include deleting its line here, which is exactly the bookkeeping
// a multi-PR train needs.
//
// dependency-cruiser cannot do this job alone: it runs post-compilation
// (tsPreCompilationDeps is deliberately unset — see .dependency-cruiser.cjs),
// so `import type` edges are erased before it sees the graph, and most of the
// executor's plan imports are type-only. The companion cruiser rule
// (`todo-tighten-executor-to-plan`, warn) covers the value edges and states the
// intent; this guard is what actually holds the line.
//
// Implementation mirrors scripts/check-plan-objectives-edge.mjs: TypeScript
// compiler API rather than raw-text regex, so comments never false-positive and
// every specifier shape is covered (import/export-from, import=require,
// dynamic import()/require(), and type-position `import('...')`).
//
// Runs in `ci:checks` (pre-push hook + CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executorDir = path.join(rootDir, 'lib', 'executor');
const planDir = path.join(rootDir, 'lib', 'plan');

// Every executor -> plan edge that exists today, as `importer -> target module`.
// SHRINK THIS LIST. Do not grow it: a new entry needs an explicit reason in the
// PR description, and the seam train's definition-of-done is this list empty and
// the cruiser rule flipped to error.
const ALLOWED = new Set([
  'binaryControlDispatch.ts -> planBinaryControl',
  'binaryControlDispatch.ts -> planBinaryControlHelpers',
  'binaryControlShared.ts -> planBinaryControlHelpers',
  'binaryControlShared.ts -> planState',
  'binaryExecutor.ts -> planBinaryControl',
  'binaryRestoreHelpers.ts -> deviceCommandability',
  'executablePlanProjection.ts -> planBinaryDevice',
  'executablePlanProjection.ts -> planSteppedLoad',
  'executablePlanProjection.ts -> planTemperatureDevice',
  'executablePlanProjection.ts -> planTypes',
  'executableSteppedLoadProjection.ts -> planBinaryDevice',
  'executableSteppedLoadProjection.ts -> planCurrentState',
  'executableSteppedLoadProjection.ts -> planSteppedLoad',
  'executableSteppedLoadProjection.ts -> planTypes',
  'executableTargetProjection.ts -> planTemperatureDevice',
  'executableTargetProjection.ts -> planTypes',
  'executorConvergence.ts -> planTypes',
  'executorSupport.ts -> admission',
  'executorSupport.ts -> planState',
  'lifecycleFallbackDispatcher.ts -> planState',
  'lifecycleFallbackDispatcher.ts -> planTypes',
  'planExecutionDrift.ts -> planSteppedLoad',
  'planExecutionDrift.ts -> planTypes',
  'planExecutor.ts -> planState',
  'planExecutor.ts -> planTypes',
  'planExecutorDispatch.ts -> planState',
  'planExecutorDispatch.ts -> planTypes',
  'planExecutorPredicates.ts -> planBinaryDevice',
  'planExecutorPredicates.ts -> planState',
  'planExecutorPredicates.ts -> planSteppedLoad',
  'planExecutorPredicates.ts -> planTypes',
  'shedReleaseActuation.ts -> planTypes',
  'shortfallExecutor.ts -> planBudget',
  'shortfallExecutor.ts -> planState',
  'steppedCommandState.ts -> planConstants',
  'steppedCommandState.ts -> planObservationPolicy',
  'steppedLoadExecutorCommand.ts -> planObservationPolicy',
  'steppedLoadExecutorContext.ts -> planState',
  'steppedLoadExecutorRestore.ts -> deviceCommandability',
  'targetCommandRetry.ts -> planConstants',
  'targetCommandRetry.ts -> planState',
  'targetExecutor.ts -> planTypes',
  'targetExecutorContext.ts -> planState',
  'targetExecutorContext.ts -> planTypes',
  'targetPendingCommand.ts -> planTypes',
]);

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// The plan target a specifier addresses, as the allowlist spells it, or null
// when the specifier does not reach into lib/plan at all.
//
// The FULL relative path is tracked, not just its top segment. An earlier
// version collapsed `../plan/admission/activationBackoff` to `admission`, which
// quietly defeated the ratchet twice over: once allowlisted, a new import of
// `../plan/admission/sheddingGuard` from the same file was invisible, and
// deleting the original edge never went stale while any file under `admission/`
// was still imported. A directory import (`../plan/admission`) resolves to the
// directory itself and is spelled without a trailing segment, so a barrel and a
// named file inside it stay distinct entries.
//
// `../plan` itself — a hypothetical `lib/plan/index.ts` barrel — is reported as
// the empty-string target rather than skipped, because a barrel import is the
// widest possible edge and the one most worth failing on.
function planTargetModule(importerPath, text) {
  const isRelative = text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../');
  if (!isRelative && !path.isAbsolute(text)) return null;
  const resolved = path.resolve(path.dirname(importerPath), text);
  if (!isWithin(planDir, resolved)) return null;
  const relative = path.relative(planDir, resolved);
  if (relative === '') return '<barrel>';
  return relative.split(path.sep).join('/').replace(/\.(tsx?|mts|cts|js|mjs|cjs)$/, '');
}

function specifierText(node) {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function collectEdges(sourceFile, importerPath, relPath, found, offenders, unresolvable) {
  const record = (node, text) => {
    if (text === null) return;
    const target = planTargetModule(importerPath, text);
    if (target === null) return;
    const key = `${relPath} -> ${target}`;
    found.add(key);
    if (!ALLOWED.has(key)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, specifier: text, key });
    }
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
    ) {
      record(node.moduleSpecifier, specifierText(node.moduleSpecifier));
    }

    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const arg = node.moduleReference.expression;
      record(arg, specifierText(arg));
    }

    // `type X = import('...').Foo` — the erased edge dependency-cruiser misses.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal, specifierText(node.argument.literal));
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        const text = specifierText(arg);
        if (text === null) {
          // A computed specifier cannot be proven to stay out of lib/plan, so it
          // is reported — but as its OWN category, not as a planner-boundary
          // violation. Filing it with the allowlist offenders would print a
          // message about lib/plan for an import that may have nothing to do
          // with the planner, and the resulting key is not addable to ALLOWED.
          const locationNode = arg ?? node;
          const { line } = sourceFile.getLineAndCharacterOfPosition(locationNode.getStart(sourceFile));
          unresolvable.push({
            file: relPath,
            line: line + 1,
            specifier: `<non-static ${isDynamicImport ? 'import()' : 'require()'}>`,
          });
        } else {
          record(arg, text);
        }
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
      return entry.isFile() && /\.(tsx?|mts|cts)$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

const files = await collectTsFiles(executorDir);
const offenders = [];
const unresolvable = [];
const found = new Set();

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectEdges(sourceFile, file, path.relative(executorDir, file), found, offenders, unresolvable);
}

const stale = [...ALLOWED].filter((key) => !found.has(key)).sort();

if (offenders.length > 0) {
  process.stderr.write(
    'Architecture boundary violation (executor -> planner source guard):\n'
    + 'lib/executor/** may only import the lib/plan modules already listed in\n'
    + `${path.relative(rootDir, fileURLToPath(import.meta.url))} (ALLOWED).\n`
    + 'The seam train is shrinking that list — do not add to it without saying why\n'
    + 'in the PR description. New edge(s):\n',
  );
  for (const { file, line, specifier } of offenders) {
    process.stderr.write(`  lib/executor/${file}:${line}  imports '${specifier}'\n`);
  }
}

if (stale.length > 0) {
  process.stderr.write(
    'Stale allowlist entries (executor -> planner source guard):\n'
    + 'These edges no longer exist in the code. Delete them from ALLOWED in\n'
    + `${path.relative(rootDir, fileURLToPath(import.meta.url))} so the ratchet cannot slip back:\n`,
  );
  for (const key of stale) {
    process.stderr.write(`  ${key}\n`);
  }
}

if (unresolvable.length > 0) {
  process.stderr.write(
    'Non-static import specifier in lib/executor/**:\n'
    + 'This guard resolves specifiers lexically, so it cannot prove a computed\n'
    + 'import()/require() stays out of lib/plan. Use a static specifier:\n',
  );
  for (const { file, line, specifier } of unresolvable) {
    process.stderr.write(`  lib/executor/${file}:${line}  ${specifier}\n`);
  }
}

if (offenders.length > 0 || stale.length > 0 || unresolvable.length > 0) process.exit(1);

process.stdout.write(
  `executor:plan-edge OK — ${found.size} allowed lib/executor -> lib/plan edges, 0 new, 0 stale `
  + `(${files.length} files scanned)\n`,
);
