import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prunedNodeModules } from './homeybuild-pruned-modules.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeyBuildDir = path.join(rootDir, '.homeybuild');
const homeyBuildPackageJsonPath = path.join(homeyBuildDir, 'package.json');

const removePath = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
};

const removeNodeModule = async (modulePath) => {
  await removePath(path.join(homeyBuildDir, 'node_modules', ...modulePath.split('/')));
};


/**
 * Sourcemaps and type declarations are dead weight in the package: Node reads
 * neither at runtime. Today every one of them lives under node_modules, which
 * Homey populates *after* applying .homeyignore — so a `**\/*.map` rule there
 * matches nothing (it silently shipped ~2.7 MB, mostly socket.io/engine.io/
 * preact). This sweep runs late enough to see the installed tree, so it is the
 * only place the removal actually happens.
 *
 * It walks the whole build rather than just node_modules so its scope matches
 * the survivor guard in scripts/check-homey-packaging.mjs. If tsc ever emits
 * declarations or sourcemaps (neither is on today), a node_modules-only sweep
 * would leave files the guard rejects and nothing could clear them.
 */
const removeDeadWeightFrom = async (absoluteDir) => {
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const absoluteEntryPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await removeDeadWeightFrom(absoluteEntryPath);
    } else if (entry.isFile() && (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts'))) {
      await removePath(absoluteEntryPath);
    }
  }
};

for (const moduleName of prunedNodeModules) {
  await removeNodeModule(moduleName);
}

await removeDeadWeightFrom(homeyBuildDir);

await removePath(path.join(homeyBuildDir, 'packages', 'contracts'));
await removePath(path.join(homeyBuildDir, 'package-lock.json'));

try {
  const packageJson = JSON.parse(await fs.readFile(homeyBuildPackageJsonPath, 'utf8'));
  delete packageJson.workspaces;
  delete packageJson.packageManager;
  delete packageJson.devDependencies;
  delete packageJson['lint-staged'];
  delete packageJson.scripts;

  await fs.writeFile(homeyBuildPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
    throw error;
  }
}

console.log('homey build sanitized.');
