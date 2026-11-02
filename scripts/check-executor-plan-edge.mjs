// Source-level enforcement of the completed planner/executor boundary.
// dependency-cruiser sees compiled value imports; this guard also rejects
// type-only edges and non-static imports before compilation can erase them.
// Neutral plan contracts cannot reach back into runtime owners, so relocating
// a planner type behind a contract re-export cannot bypass the boundary.
// Optional root argument supports isolated guard fixtures.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = process.argv[2] === undefined
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : path.resolve(process.argv[2]);
const executorDir = path.join(rootDir, 'lib', 'executor');
const planDir = path.join(rootDir, 'lib', 'plan');

const contractDir = path.join(rootDir, 'lib', 'planContract');
const libDir = path.join(rootDir, 'lib');
const contractDependencyDirs = [
  ...['planContract', 'logging', 'utils'].map((name) => path.join(libDir, name)),
  ...['contracts', 'shared-domain', 'planner-types'].map((name) => path.join(rootDir, 'packages', name)),
];

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isForbiddenSpecifier(importerPath, text) {
  const isRelative = text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../');
  if (!isRelative && !path.isAbsolute(text)) {
    return isWithin(contractDir, importerPath) && /^(homey|homey-api)(\/|$)/.test(text);
  }
  const target = path.resolve(path.dirname(importerPath), text);
  if (isWithin(executorDir, importerPath)) return isWithin(planDir, target);
  return !contractDependencyDirs.some((directory) => isWithin(directory, target));
}

function specifierText(node) {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function collectEdges(sourceFile, importerPath, relPath, offenders, unresolvable) {
  const record = (node, text) => {
    if (text === null) return;
    if (!isForbiddenSpecifier(importerPath, text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    offenders.push({ file: relPath, line: line + 1, specifier: text });
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
          // A runtime expression cannot be proven to stay inside this boundary.
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

const files = (await Promise.all([collectTsFiles(executorDir), collectTsFiles(contractDir)])).flat();
const offenders = [];
const unresolvable = [];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  collectEdges(sourceFile, file, path.relative(rootDir, file), offenders, unresolvable);
}

if (offenders.length > 0) {
  process.stderr.write(
    'Architecture boundary violation (executor/planner source guard):\n'
    + 'lib/executor/** must not import lib/plan/**, including type-only imports.\n'
    + 'lib/planContract/** must remain independent of runtime owners.\n',
  );
  for (const { file, line, specifier } of offenders) {
    process.stderr.write(`  ${file}:${line}  imports '${specifier}'\n`);
  }
}

if (unresolvable.length > 0) {
  process.stderr.write(
    'Non-static import specifier at the executor/planner boundary:\n'
    + 'Use a static import()/require() specifier so its owner can be checked.\n',
  );
  for (const { file, line, specifier } of unresolvable) {
    process.stderr.write(`  ${file}:${line}  ${specifier}\n`);
  }
}

if (offenders.length > 0 || unresolvable.length > 0) process.exit(1);

process.stdout.write(
  'executor:plan-edge OK — 0 lib/executor -> lib/plan edges; neutral contracts import no runtime layers '
  + `(${files.length} files scanned)\n`,
);
