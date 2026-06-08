// Control-model & target-power containment guard for the planner / executor.
//
// WHY THIS EXISTS: "stepped load" is now a yes/no CAPABILITY = presence of a
// valid `steppedLoadProfile`. `controlModel` is a producer-only SETTING that
// lives on the snapshot (`TargetDeviceSnapshot` / `DecoratedDeviceSnapshot`,
// consumed by lib/device + the settings UI). The planner (`lib/plan`) and the
// executor (`lib/executor`) must NEVER branch on `controlModel` — they
// discriminate stepped vs non-stepped through `isSteppedLoadDevice`
// (profile presence). Re-reading `controlModel` in a consumer re-introduces the
// config-coupling this refactor removed.
//
// Likewise the EV target-power preset is fully expanded at the producer: each
// generated stepped step carries a pre-resolved `planningCurrentA`, so the
// `targetPowerConfig` field and the `resolveTargetPowerWattsPerAmp` helper must
// not appear in `lib/plan/**` or `lib/executor/**` at all. The watts-per-amp /
// phase-count resolvers legitimately remain in `packages/shared-domain/**` and
// the transport/profile-builder (`lib/device/**`).
//
// WHAT IS ALLOWED:
//   - `lib/plan/**`: ZERO `.controlModel` property reads.
//   - `lib/executor/**`: ZERO `.controlModel` property reads EXCEPT the single
//     producer-setting read on the executor's snapshot input
//     (`snapshot.controlModel` in `lib/executor/executablePlanProjection.ts`,
//     where the value is typed `TargetDeviceSnapshot`, not a planner type).
//   - ZERO `targetPowerConfig` / `resolveTargetPowerWattsPerAmp` identifiers in
//     either directory.
//
// Implementation uses the TypeScript compiler API so comments / doc-strings
// mentioning the vocabulary never false-positive — only real code reads do.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planDir = path.join(rootDir, 'lib/plan');
const executorDir = path.join(rootDir, 'lib/executor');

// The single sanctioned `.controlModel` read in the executor: the snapshot
// (`TargetDeviceSnapshot`) producer-setting read in executablePlanProjection.
// Allowlisted by exact file + accessed-object identifier so it stays robust
// against line-number drift.
const EXECUTOR_CONTROL_MODEL_ALLOW = {
  file: 'lib/executor/executablePlanProjection.ts',
  objectIdentifier: 'snapshot',
};

const FORBIDDEN_IDENTIFIERS = new Set(['targetPowerConfig', 'resolveTargetPowerWattsPerAmp']);

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

function accessedObjectIdentifier(node) {
  // For `foo.controlModel` returns 'foo'; for `a.b.controlModel` returns null
  // (only a bare identifier object is allowlisted).
  const expr = node.expression;
  return ts.isIdentifier(expr) ? expr.text : null;
}

function collectOffenders(sourceFile, relPath, offenders, layer) {
  const visit = (node) => {
    // `controlModel` reads via property access (`x.controlModel`), bracket access
    // (`x['controlModel']`), or destructuring (`const { controlModel } = x`) — so
    // the containment guard can't be bypassed by a non-dotted access form.
    let isControlModelRead = false;
    let objectIdentifier;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'controlModel') {
      isControlModelRead = true;
      objectIdentifier = accessedObjectIdentifier(node);
    } else if (
      ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'controlModel'
    ) {
      isControlModelRead = true;
      objectIdentifier = ts.isIdentifier(node.expression) ? node.expression.text : null;
    } else if (ts.isBindingElement(node)) {
      const bound = node.propertyName ?? node.name;
      if (ts.isIdentifier(bound) && bound.text === 'controlModel') isControlModelRead = true;
    }
    if (isControlModelRead) {
      const allowed = layer === 'executor'
        && relPath === EXECUTOR_CONTROL_MODEL_ALLOW.file
        && objectIdentifier === EXECUTOR_CONTROL_MODEL_ALLOW.objectIdentifier;
      if (!allowed) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        offenders.push({ file: relPath, line: line + 1, value: 'controlModel read' });
      }
    }
    // Forbidden identifiers (targetPowerConfig / resolveTargetPowerWattsPerAmp),
    // anywhere they are written as an identifier name (property reads, imports,
    // type members, object keys).
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, value: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const [planFiles, executorFiles] = await Promise.all([
  collectTsFiles(planDir),
  collectTsFiles(executorDir),
]);

const offenders = [];
for (const { files, layer } of [{ files: planFiles, layer: 'plan' }, { files: executorFiles, layer: 'executor' }]) {
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    collectOffenders(sourceFile, path.relative(rootDir, file), offenders, layer);
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    'Control-model / target-power containment violation (check-control-model-vocab):\n'
    + 'lib/plan/** and lib/executor/** must not branch on `controlModel` (use the\n'
    + '`isSteppedLoadDevice` profile-presence guard) and must not reference\n'
    + '`targetPowerConfig` / `resolveTargetPowerWattsPerAmp` (the EV preset is\n'
    + 'pre-resolved to per-step `planningCurrentA` at the producer). The lone\n'
    + 'allowed `.controlModel` read is the snapshot producer-setting read in\n'
    + `${EXECUTOR_CONTROL_MODEL_ALLOW.file}.\n`
    + 'Offending site(s):\n',
  );
  for (const { file, line, value } of offenders) {
    process.stderr.write(`  ${file}:${line}  ${value}\n`);
  }
  process.exit(1);
}

const scanned = planFiles.length + executorFiles.length;
process.stdout.write(
  `control-model:vocab OK — no controlModel/targetPowerConfig reads in plan/executor (${scanned} files scanned)\n`,
);
