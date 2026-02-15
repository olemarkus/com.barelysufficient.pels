import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const RESVG_PKG = '@resvg/resvg-js-linux-arm64-gnu';
const RESVG_DIR = path.join(ROOT, 'node_modules', '@resvg', 'resvg-js');
const TARGET_DIR = path.join(ROOT, 'node_modules', '@resvg', 'resvg-js-linux-arm64-gnu');

if (fs.existsSync(TARGET_DIR)) {
  process.exit(0);
}

if (!fs.existsSync(RESVG_DIR)) {
  console.warn('[resvg] @resvg/resvg-js is not installed; skipping arm64 fetch.');
  process.exit(0);
}

const resvgVersion = JSON.parse(fs.readFileSync(path.join(RESVG_DIR, 'package.json'), 'utf8')).version;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resvg-arm64-'));

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', `${RESVG_PKG}@${resvgVersion}`],
    { cwd: tempDir, encoding: 'utf8' },
  ).trim();
  const tarball = packOutput.split('\n').pop();
  if (!tarball) {
    throw new Error('npm pack did not return a tarball name.');
  }
  execFileSync('tar', ['-xzf', tarball], { cwd: tempDir, stdio: 'inherit' });
  const extracted = path.join(tempDir, 'package');
  if (!fs.existsSync(extracted)) {
    throw new Error('Failed to extract resvg arm64 package.');
  }
  fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
  fs.cpSync(extracted, TARGET_DIR, { recursive: true });
  console.log(`[resvg] Installed ${RESVG_PKG}@${resvgVersion} into node_modules.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
