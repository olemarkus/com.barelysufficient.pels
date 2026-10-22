import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prunedNodeModules } from './homeybuild-pruned-modules.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeyBuildDir = path.join(rootDir, '.homeybuild');
const homeyBuildPackageJsonPath = path.join(homeyBuildDir, 'package.json');
const homeyBuildPackageLockJsonPath = path.join(homeyBuildDir, 'package-lock.json');
const forbiddenNodeModules = prunedNodeModules;

/**
 * Ceiling on the packaged app, in bytes. Calibrated against the real thing:
 * `npx homey app build` measures 14.2 MB after this PR, and ~20.3 MB before it.
 * The ceiling has to sit below that 20.3 MB or it would not have caught the
 * leak it exists for — a first pass at 22 MB was loose enough to miss it.
 *
 * 18 MB leaves ~3.8 MB, roughly nine releases at the observed ~0.4 MB/release
 * of honest code growth, and still trips on a multi-megabyte arrival: a
 * directory of dev artifacts (screenshots/, docs-shots/) or a bundler-only
 * dependency (preact, @material). When an honest release crosses it, raise it
 * in the same commit — after checking `du -sh .homeybuild/*` for a passenger.
 *
 * Only meaningful on a build that has node_modules — see below.
 */
const maxBuildBytes = 18 * 1024 * 1024;

// Validation omits production dependencies. `npm run validate` follows it with
// a full build so this guard always inspects the package that ships.

/**
 * Everything the packaged app is allowed to have at its root. An allowlist
 * rather than a denylist because the failure this catches is always something
 * *new* arriving — screenshots/ and docs-shots/ rode along for weeks because
 * nothing was looking for entries nobody had thought of.
 */
const expectedRootEntries = new Set([
  'api.js',
  'app.js',
  'app.json',
  'assets',
  'drivers',
  'flowCards',
  'lib',
  'locales',
  'node_modules',
  'package.json',
  'packages',
  'settings',
  'setup',
  'widgets',
]);

const failures = [];
let totalBytes = 0;
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
      continue;
    }

    if (entry.isFile()) {
      totalBytes += (await fs.stat(absoluteEntryPath)).size;
      // Node reads neither at runtime; scripts/sanitize-homey-build.mjs sweeps
      // them out of node_modules. A survivor means the sweep did not run.
      if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts')) {
        failures.push(`build artifact not needed at runtime: ${relativeEntryPath}`);
      }
    }
  }
};

try {
  await fs.access(homeyBuildDir);
} catch {
  console.error('homey packaging check failed: .homeybuild does not exist. Run `npm run validate` first.');
  process.exit(1);
}

try {
  await fs.access(path.join(homeyBuildDir, 'node_modules'));
} catch {
  console.error('homey packaging check failed: production dependencies are missing. Run `npm run validate` first.');
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

for (const moduleName of forbiddenNodeModules) {
  const modulePath = path.join(homeyBuildDir, 'node_modules', ...moduleName.split('/'));
  try {
    await fs.access(modulePath);
    failures.push(`node_modules/${moduleName} is still present.`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      failures.push(`node_modules/${moduleName} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

try {
  const rootEntries = await fs.readdir(homeyBuildDir, { withFileTypes: true });
  rootEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .forEach((entry) => failures.push(`unexpected root PNG artifact: ${entry.name}`));
  rootEntries
    .filter((entry) => !expectedRootEntries.has(entry.name))
    .forEach((entry) => failures.push(
      `unexpected top-level entry: ${entry.name} — add it to .homeyignore, or to expectedRootEntries here if the app really ships it.`,
    ));
} catch (error) {
  if (!isNotFoundError(error)) {
    failures.push(`root build artifacts could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const asMb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

if (totalBytes > maxBuildBytes) {
  failures.push(
    `packaged app is ${asMb(totalBytes)} MB, over the ${asMb(maxBuildBytes)} MB ceiling. Find what leaked in (\`du -sh .homeybuild/*\`) before raising it.`,
  );
}

if (failures.length > 0) {
  console.error('homey packaging check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`homey packaging check passed (full build, ${asMb(totalBytes)} MB).`);
