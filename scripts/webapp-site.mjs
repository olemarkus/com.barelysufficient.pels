#!/usr/bin/env node
// Lays out the standalone web app on the docs site (`/app/`).
//
//   node scripts/webapp-site.mjs store <dist-remote> <store-dir>
//   node scripts/webapp-site.mjs assemble <dist-remote> <store-dir> <out-dir>
//
// Each PELS version gets its own settings UI build, made from that version's
// release tag, because a Homey can only open the build of the version it runs.
// `store` (run by .github/workflows/webapp-build.yml on a release tag) copies the
// tag's `v<version>/` into the store, the `webapp-builds` branch, and keeps the
// newest KEEP_VERSIONS; an older PELS is told to update.
// `assemble` (run by the docs deploy) writes the site: the launcher, manifest
// and icons from the checkout being deployed (main), since they work with
// every version, then every stored build, then `versions.json` listing them.

import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_VERSIONS = 40;
const VERSION_DIR = /^v(\d+)\.(\d+)\.(\d+)$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const versionParts = (name) => VERSION_DIR.exec(name)?.slice(1).map(Number) ?? null;

const compareVersionDirs = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const listVersionDirs = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && versionParts(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionDirs);
};

const store = async (distRemote, storeDir) => {
  const built = await listVersionDirs(distRemote);
  if (built.length !== 1) fail(`expected one v<version>/ in ${distRemote}, found ${built.length}`);
  const [versionDir] = built;
  await fs.mkdir(storeDir, { recursive: true });
  await fs.rm(path.join(storeDir, versionDir), { recursive: true, force: true });
  await fs.cp(path.join(distRemote, versionDir), path.join(storeDir, versionDir), { recursive: true });
  const stored = await listVersionDirs(storeDir);
  for (const old of stored.slice(0, Math.max(0, stored.length - KEEP_VERSIONS))) {
    await fs.rm(path.join(storeDir, old), { recursive: true, force: true });
  }
  console.log(`Stored ${versionDir}; keeping ${(await listVersionDirs(storeDir)).join(', ')}`);
};

const assemble = async (distRemote, storeDir, outDir) => {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const launcherEntries = await fs.readdir(distRemote, { withFileTypes: true });
  for (const entry of launcherEntries) {
    if (versionParts(entry.name) || entry.name === 'versions.json') continue;
    await fs.cp(path.join(distRemote, entry.name), path.join(outDir, entry.name), { recursive: true });
  }
  const stored = await listVersionDirs(storeDir);
  for (const versionDir of stored) {
    await fs.cp(path.join(storeDir, versionDir), path.join(outDir, versionDir), { recursive: true });
  }
  const versions = stored.map((name) => name.slice(1));
  await fs.writeFile(path.join(outDir, 'versions.json'), `${JSON.stringify(versions)}\n`);
  console.log(`Assembled the web app with ${versions.length} build(s): ${versions.join(', ') || 'none yet'}`);
};

const [command, ...args] = process.argv.slice(2);
if (command === 'store' && args.length === 2) {
  await store(args[0], args[1]);
} else if (command === 'assemble' && args.length === 3) {
  await assemble(args[0], args[1], args[2]);
} else {
  fail('usage: node scripts/webapp-site.mjs store <dist-remote> <store-dir> | assemble <dist-remote> <store-dir> <out-dir>');
}
