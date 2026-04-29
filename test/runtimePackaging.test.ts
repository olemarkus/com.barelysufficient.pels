import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const runtimeRoots = ['app.ts', 'api.ts', 'capacityGuard.ts', 'drivers', 'flowCards', 'lib'];

const collectRuntimeTypeScriptFiles = (entry: string): string[] => {
  const absoluteEntry = path.join(repoRoot, entry);
  if (!fs.existsSync(absoluteEntry)) return [];
  const stat = fs.statSync(absoluteEntry);
  if (stat.isFile()) return absoluteEntry.endsWith('.ts') ? [absoluteEntry] : [];
  return fs.readdirSync(absoluteEntry, { withFileTypes: true }).flatMap((dirent) => {
    const child = path.join(entry, dirent.name);
    if (dirent.isDirectory()) return collectRuntimeTypeScriptFiles(child);
    return dirent.isFile() && dirent.name.endsWith('.ts') ? [path.join(repoRoot, child)] : [];
  });
};

const importDeclarationPattern = /import\s+(?!type\b)(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

const collectContractValueImportViolations = (): string[] => {
  const violations: string[] = [];
  const files = runtimeRoots.flatMap(collectRuntimeTypeScriptFiles);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(importDeclarationPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier.includes('packages/contracts/src')) {
        violations.push(`${path.relative(repoRoot, file)} -> ${specifier}`);
      }
    }
  }
  return violations;
};

describe('runtime packaging boundaries', () => {
  it('does not value-import deploy-excluded contract source files from Homey runtime code', () => {
    expect(collectContractValueImportViolations()).toEqual([]);
  });
});
