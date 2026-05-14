import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const sourceDir = path.join(rootDir, 'packages', 'settings-ui', 'dist');
const targetDir = path.join(rootDir, 'settings');
const files = [
  'index.html',
  'script.js',
  'style.css',
  'tokens.css',
];

const obsoleteFiles = [
  // Smart-task plan is now an in-page SPA route inside `index.html`. The old
  // standalone page is cleaned up here so a previously-installed copy does
  // not linger in the published settings/ directory after a fresh build.
  'deadline-plan.html',
];

await fs.mkdir(targetDir, { recursive: true });

for (const fileName of files) {
  await fs.copyFile(path.join(sourceDir, fileName), path.join(targetDir, fileName));
}

for (const fileName of obsoleteFiles) {
  await fs.rm(path.join(targetDir, fileName), { force: true });
}
