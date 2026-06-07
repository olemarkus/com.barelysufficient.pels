// EV-vocabulary containment guard for the planner / objectives / executor layers.
//
// WHY THIS EXISTS: the planner (`lib/plan`), objectives (`lib/objectives`) and
// executor (`lib/executor`) layers must NEVER branch on raw Homey EV plug-state
// strings (`plugged_out` / `plugged_in` / `plugged_in_paused` /
// `plugged_in_charging` / `plugged_in_discharging`). Reading those strings in a
// consumer is a bug-magnet: code starts treating `plugged_in_paused` as a
// "kept"/user-initiated pause, or invents a notion of "user-paused", or otherwise
// re-derives plug-state semantics the producer already resolved. Every such
// decision must instead go through the producer-resolved bits / shared-domain
// predicates: `isEvDevice`, `isCommandableNow`, `resolveEvBlockReasonForDevice`,
// `isEvSessionInactiveForDevice`, `resolveEvBoostBlockReason`, etc.
//
// The raw plug-state vocabulary legitimately lives ONLY in two places:
//   - the transport producer (`lib/device/**`), which parses raw Homey state, and
//   - `packages/shared-domain/**`, the browser-safe home of the EV resolvers.
// This guard locks the EV-vocabulary de-couple in place: it asserts ZERO
// plug-state string literals in the three consumer layers.
//
// Implementation uses the TypeScript compiler API (not a raw-text regex) so that
// comments and doc-strings mentioning the vocabulary never false-positive — only
// actual string-literal *values* in code are flagged.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumerDirs = ['lib/plan', 'lib/objectives', 'lib/executor'].map((d) => path.join(rootDir, d));

// The raw Homey EV plug-state values. `evcharger_charging` is intentionally NOT
// here: it is a capability id (a write-target the executor legitimately names),
// not an observation/plug-state value.
const FORBIDDEN = new Set([
  'plugged_out',
  'plugged_in',
  'plugged_in_paused',
  'plugged_in_charging',
  'plugged_in_discharging',
]);

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function collectOffenders(sourceFile, relPath, offenders) {
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null && FORBIDDEN.has(text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, value: text });
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
    'EV-vocabulary containment violation (check-ev-vocab):\n'
    + 'lib/plan/**, lib/objectives/** and lib/executor/** must not branch on raw\n'
    + 'Homey EV plug-state strings. Use the producer-resolved bits / shared-domain\n'
    + 'predicates (isEvDevice, isCommandableNow, resolveEvBlockReasonForDevice,\n'
    + 'isEvSessionInactiveForDevice, resolveEvBoostBlockReason). Raw plug-state\n'
    + 'lives only in lib/device/** (transport) and packages/shared-domain/**.\n'
    + 'Offending literal(s):\n',
  );
  for (const { file, line, value } of offenders) {
    process.stderr.write(`  ${file}:${line}  '${value}'\n`);
  }
  process.exit(1);
}

process.stdout.write(`ev:vocab OK — no raw EV plug-state literals in plan/objectives/executor (${files.length} files scanned)\n`);
