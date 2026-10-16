// Integration implementations are private. This source guard includes type-only imports,
// which the compiled dependency graph cannot see, and raw vendor discriminators.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'lib/device/deviceAdapterRegistry.ts';
const integration = /^lib\/device\/(tesla|easee|zaptec|futurehome)\//u;
const rawCapabilities = new Set([
  'charging_on', 'charging_button', 'charge_mode', 'target_charger_current',
  'measure_charge_current_max', 'measure_charge_current', 'measure_charge_power',
  'measure_charge_power_dc', 'charging_port_cable', 'car_shift_state', 'car_state',
]);
const vendorDriver = /^(?:homey:app:)?(?:com\.tesla\.car|com\.zaptec|no\.easee|no\.futurehome)(?::|$)/u;

/** Pure source check, also exercised with adversarial source fixtures. */
export function findDeviceAdapterViolations(file, source) {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const owner = integration.exec(file)?.[1];
  const violations = [];
  const report = (node, reason) => {
    violations.push({ file, line: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1, reason });
  };
  const checkImport = (node) => {
    if (!ts.isStringLiteralLike(node)) return;
    const specifier = node.text;
    if (!specifier.startsWith('.')) return;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (owner && (/^(?:lib\/(?:plan|planInput|executor|observer)|packages\/settings-ui|setup)(?:\/|$)/u.test(resolved)
      || resolved === 'lib/device/deviceAdapterRegistry')) {
      report(node, 'Integration adapters cannot depend on downstream consumers or their registry.');
      return;
    }
    const target = integration.exec(`${resolved}/`);
    if (!target) return;
    if (owner === target[1]) return;
    const entry = new RegExp(`^lib/device/${target[1]}(?:/index(?:\\.ts)?)?$`, 'u');
    if (file === registry && entry.test(resolved)) return;
    report(node, 'Import integration implementations only through their registry.');
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) checkImport(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) checkImport(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
      checkImport(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) checkImport(argument);
      else if (file.startsWith('lib/device/')) report(node, 'Device imports must be statically resolvable.');
    }
    if (!owner) {
      if (ts.isStringLiteralLike(node) && (rawCapabilities.has(node.text) || vendorDriver.test(node.text))) {
        report(node, 'Interpret raw vendor capabilities and identities inside their integration.');
      }
      if (ts.isIdentifier(node) && rawCapabilities.has(node.text)) {
        report(node, 'Interpret raw vendor capabilities inside their integration.');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return violations;
}

async function filesIn(directory) {
  const entries = await fs.readdir(path.join(rootDir, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    if (['test', 'tests', 'node_modules', 'dist'].includes(entry.name)) return [];
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesIn(file) : /\.[cm]?tsx?$/u.test(file) ? [file] : [];
  }));
  return nested.flat();
}

async function main() {
  const files = ['app.ts', 'api.ts', ...(await Promise.all(
    ['lib', 'setup', 'flowCards', 'drivers', 'packages', 'widgets'].map(filesIn),
  )).flat()];
  const violations = (await Promise.all(files.map(async (file) => (
    findDeviceAdapterViolations(file, await fs.readFile(path.join(rootDir, file), 'utf8'))
  )))).flat();
  for (const violation of violations) process.stderr.write(`${violation.file}:${violation.line}: ${violation.reason}\n`);
  if (violations.length) process.exitCode = 1;
  else process.stdout.write('device:adapters OK — integration imports and vendor interpretation stay contained.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
