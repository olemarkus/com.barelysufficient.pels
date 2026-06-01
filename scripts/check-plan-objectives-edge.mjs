// AST guard for the lib/plan -> lib/objectives type-edge boundary.
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
// module, covering value AND type imports in every specifier shape.
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
//   - import('...') / require('...')    (CallExpression; string OR template literal)
//   - type X = import('...').Foo        (ImportTypeNode; type-position import)
// Template literals with substitutions (`import(\`../objectives/${x}\`)`) are
// matched on their STATIC quasi text, which still carries the detectable prefix.
// A specifier is an offender when its text contains "objectives".
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
const planDir = path.join(rootDir, 'lib', 'plan');

function isObjectivesSpecifier(text) {
  return text.includes('objectives');
}

// Extract the literal/template specifier text from a node, or null if it isn't
// a static string we can inspect. For template literals with substitutions
// (`import(\`../objectives/${x}\`)`), the substituted values are unknowable at
// parse time, so we concatenate only the STATIC quasi text (head + each span's
// literal). That preserves the detectable static prefix (e.g. `../objectives/`)
// while dropping the variable holes.
function specifierText(node) {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  // No-substitution template literal: `import(\`...\`)`
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Template literal WITH substitutions: `import(\`../objectives/${x}\`)`
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  }
  return null;
}

function collectOffenders(sourceFile, relPath, offenders) {
  const record = (node, text) => {
    if (text !== null && isObjectivesSpecifier(text)) {
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
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const arg = node.arguments[0];
        record(arg, specifierText(arg));
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
  collectOffenders(sourceFile, path.relative(rootDir, file), offenders);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Architecture boundary violation (no-plan-to-smarttasks, type-edge guard):\n'
    + 'lib/plan/** must not import the objectives subsystem — value OR type imports.\n'
    + 'dependency-cruiser runs post-compilation and cannot see `import type` edges,\n'
    + 'so this AST guard enforces the boundary. Offending import(s):\n',
  );
  for (const { file, line, specifier } of offenders) {
    process.stderr.write(`  ${file}:${line}  imports '${specifier}'\n`);
  }
  process.exit(1);
}

process.stdout.write(`arch:grep OK — no lib/plan -> objectives import edges (${files.length} files scanned)\n`);
