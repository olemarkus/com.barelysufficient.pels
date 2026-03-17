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
await removePath(path.join(homeyBuildDir, 'node_modules', '.bin'));
await removePath(path.join(homeyBuildDir, 'packages'));
await removePath(path.join(homeyBuildDir, 'package-lock.json'));

// Remove non-ARM64 @napi-rs/canvas platform binaries (host-only, not needed on Homey).
const napiRsDir = path.join(homeyBuildDir, 'node_modules', '@napi-rs');
try {
  const entries = await fs.readdir(napiRsDir);
  for (const entry of entries) {
    if (entry.startsWith('canvas-') && !entry.includes('linux-arm64')) {
      await removePath(path.join(napiRsDir, entry));
    }
  }
} catch {
  // @napi-rs dir may not exist in .homeybuild
}

// Remove non-ARM64 .node binaries bundled inside @napi-rs/canvas itself.
const canvasDir = path.join(napiRsDir, 'canvas');
try {
  const canvasFiles = await fs.readdir(canvasDir);
  for (const file of canvasFiles) {
    if (file.endsWith('.node') && !file.includes('linux-arm64')) {
      await removePath(path.join(canvasDir, file));
    }
  }
} catch {
  // canvas dir may not exist
}

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
