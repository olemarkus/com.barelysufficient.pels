// Grep guard for the lib/plan -> lib/objectives type-edge boundary.
//
// WHY THIS EXISTS: .dependency-cruiser.cjs runs post-compilation
// (tsPreCompilationDeps is unset), so `import type` edges are erased by tsc
// before the cruiser ever sees the graph. The `no-plan-to-smarttasks` rule
// therefore only catches VALUE imports; a future
//   import type { X } from '../objectives/...'
// inside lib/plan/** would compile and pass `arch:check` silently.
//
// This guard promotes the previously-manual audit (documented in
// .dependency-cruiser.cjs next to `no-plan-to-smarttasks`) into an enforced
// check: it asserts ZERO import edges from lib/plan/** to any objectives
// module, covering both value AND type imports, with single or double quotes.
// Flipping tsPreCompilationDeps to true was deliberately rejected (it surfaces
// ~18 pre-existing type-only no-circular violations and doubles the cruised
// graph) — see TODO.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planDir = path.join(rootDir, 'lib', 'plan');

// Matches every module-specifier shape that creates a graph edge to the
// objectives subsystem, in single or double quotes:
//   - `import ... from '...objectives...'`     (value or `import type`)
//   - `export ... from '...objectives...'`     (re-export)
//   - `import('...objectives...')`             (dynamic / inline `import(...)` type)
// Only the specifier string is inspected, so the word "objectives" appearing in
// code or comments outside a module specifier is ignored.
const FORBIDDEN_SPECIFIER = /\b(?:from|import)\s*\(?\s*(['"])([^'"]*objectives[^'"]*)\1/g;

async function collectTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

const files = await collectTsFiles(planDir);
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  for (const match of source.matchAll(FORBIDDEN_SPECIFIER)) {
    const line = source.slice(0, match.index).split('\n').length;
    offenders.push({
      file: path.relative(rootDir, file),
      line,
      specifier: match[2],
    });
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    'Architecture boundary violation (no-plan-to-smarttasks, type-edge guard):\n'
    + 'lib/plan/** must not import the objectives subsystem — value OR type imports.\n'
    + 'dependency-cruiser runs post-compilation and cannot see `import type` edges,\n'
    + 'so this grep guard enforces the boundary. Offending import(s):\n',
  );
  for (const { file, line, specifier } of offenders) {
    process.stderr.write(`  ${file}:${line}  imports '${specifier}'\n`);
  }
  process.exit(1);
}

process.stdout.write(`arch:grep OK — no lib/plan -> objectives import edges (${files.length} files scanned)\n`);
