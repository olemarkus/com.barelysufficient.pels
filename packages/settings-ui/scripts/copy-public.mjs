import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const publicDir = path.join(packageDir, 'public');
const distDir = path.join(packageDir, 'dist');

await fs.mkdir(distDir, { recursive: true });
await fs.copyFile(path.join(publicDir, 'index.html'), path.join(distDir, 'index.html'));
await fs.copyFile(path.join(publicDir, 'style.css'), path.join(distDir, 'style.css'));
