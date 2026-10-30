// API manifest parity: the route names `api.ts` exports must equal the `api`
// keys declared in `.homeycompose/app.json`.
//
// WHY THIS EXISTS: Homey dispatches a settings-UI or widget request by the
// manifest key and looks the handler up on `api.ts`'s export by the same name.
// A handler with no manifest entry is unreachable; a manifest entry with no
// handler fails at request time. Neither shows up in a typecheck, so a route
// renamed, moved between route tables, or removed on one side only would ship.
//
// HOW: parses `api.ts` without running it. The default export is an object
// literal (`export =` or `export default`), optionally wrapped in a call or
// `satisfies`/`as`. Its keys are its own properties plus every spread element,
// and a spread of an identifier imported from a relative module is followed to
// that module's exported `const`, recursively. Anything the parser cannot
// resolve to literal keys (a computed name, a spread of a call result) fails the
// check rather than being skipped, so the comparison is never partial.
//
// Runs in `ci:checks` (the pre-push hook and the CI checks job).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [apiArg, manifestArg] = process.argv.slice(2);
const apiFile = path.resolve(rootDir, apiArg ?? 'api.ts');
const manifestFile = path.resolve(rootDir, manifestArg ?? '.homeycompose/app.json');

const sourceCache = new Map();
function parse(file) {
  if (!sourceCache.has(file)) {
    const text = fs.readFileSync(file, 'utf8');
    sourceCache.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return sourceCache.get(file);
}

function resolveModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${path.relative(rootDir, fromFile)}`);
}

function where(node) {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(rootDir, sourceFile.fileName)}:${line + 1}`;
}

/** Strip `x as T`, `x satisfies T`, `(x)`, and `defineRoutes(x)`-style wrappers. */
function unwrap(node) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isParenthesizedExpression(node)) {
    return unwrap(node.expression);
  }
  if (ts.isCallExpression(node) && node.arguments.length === 1) return unwrap(node.arguments[0]);
  return node;
}

function findLocalConst(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function findImport(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) return undefined;
      return {
        file: resolveModule(sourceFile.fileName, specifier),
        exportedName: (element.propertyName ?? element.name).text,
      };
    }
  }
  return undefined;
}

function resolveIdentifier(identifier) {
  const sourceFile = identifier.getSourceFile();
  const local = findLocalConst(sourceFile, identifier.text);
  if (local) return local;
  const imported = findImport(sourceFile, identifier.text);
  if (imported) {
    const target = findLocalConst(parse(imported.file), imported.exportedName);
    if (target) return target;
  }
  throw new Error(`${where(identifier)}: cannot resolve spread of ${identifier.text} to an object literal`);
}

function collectKeys(expression, keys) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return collectKeys(resolveIdentifier(node), keys);
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error(`${where(node)}: route table is not an object literal`);
  }
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      collectKeys(property.expression, keys);
      continue;
    }
    const { name } = property;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) {
      throw new Error(`${where(property)}: route name is not a literal`);
    }
    if (keys.has(name.text)) throw new Error(`${where(property)}: route ${name.text} is declared twice`);
    keys.add(name.text);
  }
  return keys;
}

function exportedRouteTable(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) return statement.expression;
  }
  throw new Error(`${path.relative(rootDir, sourceFile.fileName)} has no default export`);
}

let exported;
try {
  exported = collectKeys(exportedRouteTable(parse(apiFile)), new Set());
} catch (error) {
  process.stderr.write(`API manifest parity (check-api-manifest-parity): ${error.message}\n`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const declared = new Set(Object.keys(manifest.api ?? {}));

const missingHandler = [...declared].filter((key) => !exported.has(key)).sort();
const missingManifest = [...exported].filter((key) => !declared.has(key)).sort();

if (missingHandler.length > 0 || missingManifest.length > 0) {
  process.stderr.write(
    'API manifest parity violation (check-api-manifest-parity):\n'
    + `The routes ${path.relative(rootDir, apiFile)} exports must equal the "api" keys in `
    + `${path.relative(rootDir, manifestFile)}.\n`,
  );
  for (const key of missingHandler) process.stderr.write(`  ${key} — declared in the manifest, no handler\n`);
  for (const key of missingManifest) process.stderr.write(`  ${key} — handler exported, not in the manifest\n`);
  process.exit(1);
}

process.stdout.write(`api:manifest-parity OK — ${exported.size} routes\n`);
