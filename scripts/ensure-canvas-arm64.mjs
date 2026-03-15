import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const CANVAS_PKG = '@napi-rs/canvas-linux-arm64-gnu';
const CANVAS_DIR = path.join(ROOT, 'node_modules', '@napi-rs', 'canvas');
const TARGET_DIR = path.join(ROOT, 'node_modules', '@napi-rs', 'canvas-linux-arm64-gnu');

if (fs.existsSync(TARGET_DIR)) {
  process.exit(0);
}

if (!fs.existsSync(CANVAS_DIR)) {
  console.warn('[canvas] @napi-rs/canvas is not installed; skipping arm64 fetch.');
  process.exit(0);
}

const canvasPkg = JSON.parse(fs.readFileSync(path.join(CANVAS_DIR, 'package.json'), 'utf8'));
const optDeps = canvasPkg.optionalDependencies || {};
const version = (optDeps[CANVAS_PKG] || '').replace(/^\^|~/, '') || canvasPkg.version;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-arm64-'));

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', `${CANVAS_PKG}@${version}`],
    { cwd: tempDir, encoding: 'utf8' },
  ).trim();
  const tarball = packOutput.split('\n').pop();
  if (!tarball) {
    throw new Error('npm pack did not return a tarball name.');
  }
  execFileSync('tar', ['-xzf', tarball], { cwd: tempDir, stdio: 'inherit' });
  const extracted = path.join(tempDir, 'package');
  if (!fs.existsSync(extracted)) {
    throw new Error('Failed to extract canvas arm64 package.');
  }
  fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
  fs.cpSync(extracted, TARGET_DIR, { recursive: true });
  console.log(`[canvas] Installed ${CANVAS_PKG}@${version} into node_modules.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
