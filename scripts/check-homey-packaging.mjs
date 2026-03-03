import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeyBuildDir = path.join(rootDir, '.homeybuild');
const homeyBuildPackageJsonPath = path.join(homeyBuildDir, 'package.json');
const homeyBuildPackageLockJsonPath = path.join(homeyBuildDir, 'package-lock.json');

const failures = [];
const isNotFoundError = (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const walk = async (absoluteDir) => {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const absoluteEntryPath = path.join(absoluteDir, entry.name);
    const relativeEntryPath = path.relative(homeyBuildDir, absoluteEntryPath).split(path.sep).join('/');

    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(absoluteEntryPath);
      failures.push(`${relativeEntryPath} -> ${linkTarget}`);
      continue;
    }

    if (entry.isDirectory()) {
      await walk(absoluteEntryPath);
    }
  }
};

try {
  await fs.access(homeyBuildDir);
} catch {
  console.error('homey packaging check failed: .homeybuild does not exist. Run `npm run validate` or `homey app validate` first.');
  process.exit(1);
}

await walk(homeyBuildDir);

try {
  const packageJson = JSON.parse(await fs.readFile(homeyBuildPackageJsonPath, 'utf8'));
  if (Object.hasOwn(packageJson, 'workspaces')) {
    failures.push('package.json still contains workspaces.');
  }
} catch (error) {
  if (!isNotFoundError(error)) {
    failures.push(`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  await fs.access(homeyBuildPackageLockJsonPath);
  failures.push('package-lock.json is still present.');
} catch (error) {
  if (!isNotFoundError(error)) {
    failures.push(`package-lock.json could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error('homey packaging check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('homey packaging check passed.');
