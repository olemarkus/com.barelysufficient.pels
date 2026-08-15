// Control-model & target-power containment guard.
//
// WHY THIS EXISTS: "stepped load" is a yes/no CAPABILITY = presence of a valid
// `steppedLoadProfile`. `controlModel` is a producer-only SETTING that lives on
// the snapshot (`TargetDeviceSnapshot` / `DecoratedDeviceSnapshot`, consumed by
// lib/device + the settings-UI DEVICE page, where "what kind of control is this"
// is the actual question). A CONSUMER that re-reads it re-introduces the
// config-coupling this refactor removed: it must discriminate on the cluster
// that carries what it needs — `isSteppedLoadDevice` / `steppedLoad` presence
// for a step ladder, `temperature` facet presence for a setpoint.
//
// Likewise the EV target-power preset is fully expanded at the producer: each
// generated stepped step carries a pre-resolved `planningCurrentA`, so the
// `targetPowerConfig` field and the `resolveTargetPowerWattsPerAmp` helper must
// not appear in a consuming layer at all. They belong to the transport /
// profile-builder (`lib/device/**`) and to the device page's own config surface
// (`packages/settings-ui/src/**`), neither of which this guard scans.
//
// SCANNED DIRECTORIES — one uniform rule, no per-directory carve-outs:
//   - `lib/plan/**`
//   - `lib/executor/**`
//   - `packages/shared-domain/src/**`   (added 2026-08-15)
//
// In each: ZERO `.controlModel` property reads, and ZERO `targetPowerConfig` /
// `resolveTargetPowerWattsPerAmp` identifiers.
//
// On shared-domain: `controlModel` left the overview wire entirely — the stepped
// discriminant is presence of the `steppedLoad` cluster and the temperature card
// keys on presence of the atomic `temperature` facet. It survived here as long
// as it did by GEOGRAPHY, not by argument: the guard simply did not look. An
// earlier revision of this file claimed the watts-per-amp / phase-count
// resolvers "legitimately remain in packages/shared-domain/**" and exempted the
// directory from the identifier half on that basis. That claim was stale —
// `resolveTargetPowerWattsPerAmp` no longer exists anywhere in the repo, and
// `targetPowerConfig` appears in shared-domain only inside comments (which the
// AST walk never flags). So the exemption bought nothing and is gone; if a real
// need appears, this comment is where the argument goes.
//
// There is no allowlist. Until 2026-08-12 the executor had one carve-out — the
// producer-setting read in `executablePlanProjection` — which now asks
// `isSteppedLoadSnapshot` instead, so it was deleted rather than left dormant.
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
const sharedDomainDir = path.join(rootDir, 'packages/shared-domain/src');

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


function collectOffenders(sourceFile, relPath, offenders) {
  const visit = (node) => {
    // `controlModel` reads via property access (`x.controlModel`), bracket access
    // (`x['controlModel']`), or destructuring (`const { controlModel } = x`) — so
    // the containment guard can't be bypassed by a non-dotted access form.
    let isControlModelRead = false;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'controlModel') {
      isControlModelRead = true;
    } else if (
      ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'controlModel'
    ) {
      isControlModelRead = true;
    } else if (ts.isBindingElement(node)) {
      const bound = node.propertyName ?? node.name;
      if (ts.isIdentifier(bound) && bound.text === 'controlModel') isControlModelRead = true;
    }
    if (isControlModelRead) {
      // No exemptions. The executor's last sanctioned read — the snapshot
      // producer-setting branch in `executablePlanProjection` — now asks
      // `isSteppedLoadSnapshot` instead, so both layers are at zero and the
      // allowlist that used to carve it out is gone rather than merely unused.
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, value: 'controlModel read' });
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

const [planFiles, executorFiles, sharedDomainFiles] = await Promise.all([
  collectTsFiles(planDir),
  collectTsFiles(executorDir),
  collectTsFiles(sharedDomainDir),
]);

const offenders = [];
// All three directories are scanned under ONE rule. Every consuming layer owes
// the same containment; a per-directory exemption would be the geography
// argument that let `controlModel` survive in shared-domain in the first place.
for (const file of [...planFiles, ...executorFiles, ...sharedDomainFiles]) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Control-model / target-power containment violation (check-control-model-vocab):\n'
    + 'lib/plan/**, lib/executor/** and packages/shared-domain/src/** must not\n'
    + 'branch on `controlModel` — discriminate on the CLUSTER that carries what you\n'
    + 'need: `isSteppedLoadDevice` / `steppedLoad` presence for a step ladder,\n'
    + '`temperature` facet presence for a setpoint.\n'
    + 'They must also not reference `targetPowerConfig` /\n'
    + '`resolveTargetPowerWattsPerAmp`: the EV preset is pre-resolved to per-step\n'
    + '`planningCurrentA` at the producer. Those belong to lib/device/** and the\n'
    + 'device page under packages/settings-ui/src/**, neither of which is scanned.\n'
    + 'There is no allowlist and no per-directory exemption.\n'
    + 'Offending site(s):\n',
  );
  for (const { file, line, value } of offenders) {
    process.stderr.write(`  ${file}:${line}  ${value}\n`);
  }
  process.exit(1);
}

const scanned = planFiles.length + executorFiles.length + sharedDomainFiles.length;
process.stdout.write(
  'control-model:vocab OK — no controlModel/targetPowerConfig reads in '
  + `plan/executor/shared-domain (${scanned} files scanned)\n`,
);
