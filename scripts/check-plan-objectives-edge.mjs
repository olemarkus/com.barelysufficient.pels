// AST guard for lib/plan source-level layer boundaries.
//
// WHY THIS EXISTS: .dependency-cruiser.cjs runs post-compilation
// (tsPreCompilationDeps is unset), so `import type` edges are erased by tsc
// before the cruiser ever sees the graph. The `no-plan-to-smarttasks` and
// `no-plan-to-executor` rules therefore only catch VALUE imports; a future
// type-only edge from lib/plan/** would compile and pass `arch:check` silently.
//
// This guard promotes the previously-manual audit (documented in
// .dependency-cruiser.cjs next to `no-plan-to-smarttasks`) into an enforced
// check: it asserts ZERO import edges from lib/plan/** to objectives OR
// executor modules, covering value AND type imports in every specifier shape.
// Flipping tsPreCompilationDeps to true was deliberately rejected (it surfaces
// ~18 pre-existing type-only no-circular violations and doubles the cruised
// graph) — see TODO.md.
//
// Implementation uses the TypeScript compiler API rather than a raw-text
// regex. The AST natively ignores comments (so a commented-out objectives
// import never false-positives) and exposes every specifier shape:
//   - import ... from '...'            (ImportDeclaration)
//   - export ... from '...'            (ExportDeclaration with moduleSpecifier)
//   - import X = require('...')         (ImportEqualsDeclaration)
//   - import('...') / require('...')    (CallExpression; static string/template only)
//   - type X = import('...').Foo        (ImportTypeNode; type-position import)
// Computed dynamic import()/require() arguments are rejected outright: a source
// guard cannot prove which layer a runtime expression will address.
// A static repository specifier is resolved lexically from its importer and is
// an offender only when that target lives under either forbidden peer. Bare
// package specifiers are outside this repository boundary and remain allowed.
//
// This guard runs in `ci:checks` (the pre-push hook and the CI checks job),
// NOT the pre-commit hook (which only runs lint-staged +
// scripts/pre-commit-extra-checks.mjs).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planDir = process.argv[2] === undefined
  ? path.join(rootDir, 'lib', 'plan')
  : path.resolve(process.argv[2]);

const forbiddenPeerDirs = ['objectives', 'executor']
  .map((peer) => path.join(rootDir, 'lib', peer));

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isForbiddenPeerSpecifier(importerPath, text) {
  const isRelative = text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../');
  if (!isRelative && !path.isAbsolute(text)) return false;
  const resolvedTarget = path.resolve(path.dirname(importerPath), text);
  return forbiddenPeerDirs.some((directory) => isWithin(directory, resolvedTarget));
}

// Extract a fully static specifier, or null when runtime evaluation is needed.
function specifierText(node) {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  // No-substitution template literal: `import(\`...\`)`
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function collectOffenders(sourceFile, importerPath, relPath, offenders) {
  const record = (node, text) => {
    if (text !== null && isForbiddenPeerSpecifier(importerPath, text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenders.push({ file: relPath, line: line + 1, specifier: text });
    }
  };

  const visit = (node) => {
    // import ... from '...'  /  export ... from '...'
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
    ) {
      record(node.moduleSpecifier, specifierText(node.moduleSpecifier));
    }

    // import X = require('...')
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const arg = node.moduleReference.expression;
      record(arg, specifierText(arg));
    }

    // TYPE-position import: `type X = import('...').Foo` / `let v: import('...').Bar`
    // (ImportTypeNode). Its `argument` is a LiteralTypeNode wrapping a string
    // literal — NOT a CallExpression, so the dynamic-import branch below misses
    // it. This is the exact `import type`-erased edge this guard exists to catch.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      record(literal, specifierText(literal));
    }

    // import('...') / require('...')  (string OR template-literal argument)
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        const text = specifierText(arg);
        if (text === null) {
          const locationNode = arg ?? node;
          const { line } = sourceFile.getLineAndCharacterOfPosition(locationNode.getStart(sourceFile));
          offenders.push({
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
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    }),
  );
  return files.flat();
}

const files = await collectTsFiles(planDir);
const offenders = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectOffenders(sourceFile, file, path.relative(rootDir, file), offenders);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Architecture boundary violation (planner peer source guard):\n'
    + 'lib/plan/** must not import objectives or executor modules — value OR type imports.\n'
    + 'dependency-cruiser runs post-compilation and cannot see `import type` edges,\n'
    + 'so this AST guard enforces the boundary. Offending import(s):\n',
  );
  for (const { file, line, specifier } of offenders) {
    process.stderr.write(`  ${file}:${line}  imports '${specifier}'\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `arch:grep OK — no lib/plan -> objectives/executor import edges (${files.length} files scanned)\n`,
);
