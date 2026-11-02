// Binary-control transport-seam containment guard for the executor layer.
//
// Binary commands reach the actuator through executor-owned preflight and
// dispatch. The actuator's transport resolves native-versus-Flow routing;
// executor callers track the same pending/confirmation lifecycle for both.
//
// This guard keeps routing internals sealed: ZERO references under
// lib/executor/** to isFlowBackedBinaryControl or flowBackedCapabilityIds.
// Banning the raw field as well as the helper prevents inline re-derivation.
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
    + 'flowBackedCapabilityIds. Flow-vs-native routing belongs to the actuator\n'
    + 'transport; never re-derive it from the snapshot.\n'
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
