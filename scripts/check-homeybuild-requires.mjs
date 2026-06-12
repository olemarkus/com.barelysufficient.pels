#!/usr/bin/env node
/**
 * Packaged-app require-graph smoke: walks every relative `require(...)` in the
 * built `.homeybuild/` bundle and fails on unresolvable modules.
 *
 * Why this exists: every test lane resolves modules from SOURCE (vitest/tsc),
 * and `homey app validate` never requires the compiled bundle — so a module
 * that is missing only in the packaged layout (e.g. a value import of
 * packages/contracts, which scripts/sanitize-homey-build.mjs deletes) passes
 * all of CI and crash-loops the app at boot with MODULE_NOT_FOUND (prod
 * outage 2026-06-12). This walk is static — nothing is executed — so it is
 * safe to run in CI right after `npm run build`.
 *
 * Bare specifiers ('homey', node_modules packages, node builtins) are skipped:
 * 'homey' is provided by the runtime, and node_modules ships wholesale.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { prunedNodeModules } from './homeybuild-pruned-modules.mjs';
import path from 'node:path';
import process from 'node:process';

const buildDir = path.resolve(process.cwd(), '.homeybuild');
if (!existsSync(buildDir)) {
  console.error(`check-homeybuild-requires: ${buildDir} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

// tsc CJS output emits plain `require("...")` / `require('...')` calls.
const REQUIRE_PATTERN = /require\((["'])([^"']+)\1\)/g;

const resolveRelative = (fromFile, specifier) => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  // Mirror Node's CJS order: exact file, .js/.json extensions, then directory
  // resolution via package.json `main`, then index.js/index.json.
  for (const candidate of [base, `${base}.js`, `${base}.json`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    const packageJsonPath = path.join(base, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const main = JSON.parse(readFileSync(packageJsonPath, 'utf8')).main;
        if (typeof main === 'string') {
          const resolved = resolveRelative(packageJsonPath, `./${main}`);
          if (resolved !== null) return resolved;
        }
      } catch {
        // Malformed package.json: fall through to index resolution.
      }
    }
    for (const candidate of [path.join(base, 'index.js'), path.join(base, 'index.json')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
};

const collectEntries = () => {
  const entries = [];
  for (const name of ['app.js', 'api.js']) {
    const file = path.join(buildDir, name);
    if (existsSync(file)) entries.push(file);
  }
  const driversDir = path.join(buildDir, 'drivers');
  if (existsSync(driversDir)) {
    for (const driver of readdirSync(driversDir)) {
      for (const name of ['driver.js', 'device.js']) {
        const file = path.join(driversDir, driver, name);
        if (existsSync(file)) entries.push(file);
      }
    }
  }
  return entries;
};

// Union of the sanitize prune list and .homeyignore's node_modules/ entries,
// as bare-specifier prefixes ('.bin' can never appear in a require()).
const homeyIgnorePrunes = existsSync('.homeyignore')
  ? readFileSync('.homeyignore', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node_modules/') && line !== 'node_modules/.bin/')
    .map((line) => line.slice('node_modules/'.length).replace(/\/$/, ''))
  : [];
const prunedBarePrefixes = [...new Set([...prunedNodeModules, ...homeyIgnorePrunes])]
  .filter((prefix) => prefix !== '.bin');

const seen = new Set();
const queue = collectEntries();
const missing = [];

if (queue.length === 0) {
  console.error('check-homeybuild-requires: no entry modules found in .homeybuild — packaging layout changed?');
  process.exit(1);
}

while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(REQUIRE_PATTERN)) {
    // tsc preserves comments: skip requires that sit behind a line comment.
    const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
    if (source.slice(lineStart, match.index ?? 0).includes('//')) continue;
    const specifier = match[2];
    // Bare specifiers resolving into a pruned package (sanitize list +
    // .homeyignore node_modules/ entries) are always a boot crash: the
    // package exists in the dev tree but not in the shipped bundle.
    const pruned = prunedBarePrefixes.find(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    );
    if (pruned !== undefined) {
      missing.push({ from: path.relative(buildDir, file), specifier: `${specifier} (node_modules/${pruned} is pruned from the bundle)` });
      continue;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    const resolved = resolveRelative(file, specifier);
    if (resolved === null) {
      missing.push({ from: path.relative(buildDir, file), specifier });
    } else if (resolved.endsWith('.js')) {
      queue.push(resolved);
    }
  }
}

if (missing.length > 0) {
  console.error('Unresolvable relative require() in the packaged app (would crash at boot with MODULE_NOT_FOUND):');
  for (const { from, specifier } of missing) {
    console.error(`  ${from} -> ${specifier}`);
  }
  process.exit(1);
}
console.log(`check-homeybuild-requires: ${seen.size} packaged modules resolve cleanly.`);
