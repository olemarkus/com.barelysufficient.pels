import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeyBuildDir = path.join(rootDir, '.homeybuild');
const homeyBuildPackageJsonPath = path.join(homeyBuildDir, 'package.json');

const removePath = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
};

await removePath(path.join(homeyBuildDir, 'node_modules', '@pels'));
await removePath(path.join(homeyBuildDir, 'node_modules', '@napi-rs'));
await removePath(path.join(homeyBuildDir, 'node_modules', '.bin'));
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
