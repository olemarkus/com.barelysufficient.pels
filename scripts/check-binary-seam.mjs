// Binary-control transport-seam containment guard for the executor layer.
//
// WHY THIS EXISTS: flow-vs-native routing for binary (on/off) control is a
// producer-resolved transport detail. The plan layer resolves it ONCE
// (`isFlowBackedBinaryControl` in `lib/plan/planBinaryControl*`), packages it on
// the `BinaryControlDecision`, and the dispatch seam
// (`lib/executor/binaryControlDispatch.ts`) routes the write through the actuator
// and surfaces the resolved flag outward as `BinaryControlOutcome.flowBacked`.
//
// The executor's post-write recording sites (shed / restore / control-off
// restore) must read `outcome.flowBacked` — they must NEVER re-derive the routing
// by calling `isFlowBackedBinaryControl` against the snapshot again. Recomputing
// re-couples the executor to flow-vs-native transport internals (the exact leak
// the planner/executor/device-transport boundary split set out to remove) and
// risks deciding against a different snapshot than the one dispatched.
//
// This guard locks that seal in place: ZERO references anywhere under
// `lib/executor/**` to either the resolver symbol `isFlowBackedBinaryControl`
// OR the raw `flowBackedCapabilityIds` snapshot field it reads. Banning only the
// symbol would leave the seam re-leakable via an inline re-derivation
// (`snapshot.flowBackedCapabilityIds.includes(capabilityId)`); banning the field
// too keeps the executor off the routing internals entirely. Both legitimately
// live only in the plan layer (`lib/plan/**`) and the transport producer
// (`lib/device/**`), which are out of scope here.
//
// Detection is AST-based (not a raw-text regex) so comments and doc-strings that
// mention either name never false-positive — only real identifier references in
// code are flagged.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executorDir = path.join(rootDir, 'lib/executor');

// Both the resolver and the raw field it reads are off-limits in the executor.
const FORBIDDEN_SYMBOLS = new Set(['isFlowBackedBinaryControl', 'flowBackedCapabilityIds']);

function collectOffenders(sourceFile, relPath, offenders) {
  const visit = (node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_SYMBOLS.has(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, symbol: node.text });
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

const files = await collectTsFiles(executorDir);
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Binary-control seam violation (check-binary-seam):\n'
    + 'lib/executor/** must not reference isFlowBackedBinaryControl or\n'
    + 'flowBackedCapabilityIds. Flow-vs-native routing is producer-resolved; read\n'
    + 'it from BinaryControlOutcome.flowBacked (the resolved dispatch outcome),\n'
    + 'never by re-deriving from the snapshot.\n'
    + 'Offending reference(s):\n',
  );
  for (const { file, line, symbol } of offenders) {
    process.stderr.write(`  ${file}:${line}  '${symbol}'\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `binary:seam OK — executor reads no flow-backed transport internals (${files.length} files scanned)\n`,
);
