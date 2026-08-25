#!/usr/bin/env node
/**
 * Collapses the compiled `.homeybuild/` module tree into ONE bundled script.
 *
 * Why this exists: the app process loads ~690 separate CommonJS modules,
 * ~5 MB of JavaScript, at boot. Retained *data* is negligible (tens of KB of
 * diagnostics, price and weather state), so that loaded code is essentially
 * what the V8 heap holds — and V8 keeps each script's source text alongside
 * its bytecode. Prod measurement (2026-08-25): heap sits at 38-48 MB while
 * RSS plateaus at ~150 MB against Homey's 160 MB watchdog ceiling, so the
 * whole margin is ~10 MB. Tree-shaking and minifying the loaded source is the
 * only app-level lever on that plateau — the other half of RSS is the Node
 * binary's file-backed pages, which no app code can move.
 *
 * ONE bundle, not one per entry point: `api.js` reaches 1.22 MB of the same
 * modules `app.js` does, and Homey loads both into the SAME process. Bundling
 * them separately would load that overlap twice and cost more than it saved.
 * So everything is inlined once and each entry file becomes a stub re-exporting
 * its slice.
 *
 * Runs after `tsc` and before `sanitize:homey-build`. Bare specifiers stay
 * external (`packages: 'external'`) because node_modules ships wholesale and
 * `pino`/`socket.io-client` must resolve at runtime, not be inlined.
 */
import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(rootDir, '.homeybuild');

/** Name of the single emitted bundle, at the build root. */
const BUNDLE_BASENAME = '_pels-runtime.js';
/** Synthetic entry, deleted once esbuild has read it. */
const SYNTHETIC_BASENAME = '_pels-entry.js';

/**
 * The files Homey itself loads by path — `app.js` and `api.js` by convention,
 * driver/device via the driver id in app.json. Each must keep existing at its
 * own path, so each becomes a stub. The key is how the bundle exposes it.
 *
 * Widget API entry points are appended below: `widgets/<id>/api.js` is loaded
 * by the widget runtime INSIDE the app process, so it belongs in the same
 * bundle as everything else. Giving each widget its own bundle is the mistake
 * `scripts/build-widgets.mjs` documents and reverted — it inlined a private
 * copy of every transitive shared-domain helper into all five widgets, code
 * the app process had already loaded once. One bundle keeps the single copy.
 */
const fixedEntryPoints = [
  { file: 'app.js', key: 'app' },
  { file: 'api.js', key: 'api' },
  { file: 'drivers/pels_insights/driver.js', key: 'insightsDriver' },
  { file: 'drivers/pels_insights/device.js', key: 'insightsDevice' },
];

/**
 * Compiled output that is wholly reachable from the entry points and therefore
 * wholly inlined into the bundle. Deleted afterwards so the package does not
 * ship two copies of the same code — and so a stray `require` of a path that no
 * longer participates in the build fails loudly here rather than at boot.
 *
 * `settings/` is deliberately absent: it is served to the Homey WebView and
 * never required by the app process. `widgets/` is handled separately — its
 * app-side `src/` is inlined, but `public/` holds the browser bundle that
 * `scripts/build-widgets.mjs` produces and must survive untouched.
 */
const inlinedDirs = ['lib', 'setup', 'flowCards', 'packages'];

const byteSize = async (dir) => {
  let total = 0;
  const walk = async (absolute) => {
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const next = path.join(absolute, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) total += (await fs.stat(next)).size;
    }
  };
  await walk(dir);
  return total;
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const fail = (message) => {
  console.error(`bundle-homey-build: ${message}`);
  process.exit(1);
};

const buildDirExists = await fs
  .stat(buildDir)
  .then((stat) => stat.isDirectory())
  .catch(() => false);
if (!buildDirExists) fail(`${buildDir} does not exist — run \`tsc\` first.`);

/**
 * Widget ids come from the COMPILED tree — a `widgets/<id>/src/api.js` is what
 * makes a widget app-side, and tsc emits it in every build shape.
 *
 * Deriving them from app.json instead does not work: CI runs `npm run build`
 * directly, without the Homey CLI's `preprocess()` source copy, so there is no
 * app.json in `.homeybuild` at all. That made the widget lane silently skip
 * while `lib/` and `packages/` were still deleted — leaving the widget sources
 * pointing at directories that no longer existed, which is exactly what
 * `scripts/check-homeybuild-requires.mjs` failed the build on.
 *
 * app.json, when present, is still used as a cross-check: a widget that
 * declares an API but has no compiled implementation is a broken package, not
 * an opt-out, and would 404 at runtime with no build-time signal.
 */
const listWidgetIds = async () => {
  let entries;
  try {
    entries = await fs.readdir(path.join(buildDir, 'widgets'), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const api = path.join(buildDir, 'widgets', entry.name, 'src', 'api.js');
    if (await fs.stat(api).then(() => true).catch(() => false)) ids.push(entry.name);
  }
  return ids;
};

const crossCheckAgainstManifest = async (ids) => {
  let raw;
  try {
    raw = await fs.readFile(path.join(buildDir, 'app.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const declared = Object.keys(JSON.parse(raw).widgets ?? {});
  const missing = declared.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    fail(`app.json declares widget API(s) with no compiled src/api.js: ${missing.join(', ')}`);
  }
};

const widgetIds = await listWidgetIds();
await crossCheckAgainstManifest(widgetIds);
// Bundle the COMPILED api (`src/api.js`, always fresh tsc output), never the
// committed `api.js` shim beside it. The shim is copied in by the CLI, and this
// script rewrites it to point at the bundle — so feeding the shim to esbuild
// would make a re-run read back its own previous output and fail with
// "Refusing to overwrite input file". Reading only tsc output keeps the step
// idempotent, which matters because `npm run build` is run by hand far more
// often than the CLI clears `.homeybuild`.
const widgetEntryPoints = widgetIds.map((id) => ({
  file: `widgets/${id}/src/api.js`,
  stub: `widgets/${id}/api.js`,
  key: `widget_${id}`,
}));

const entryPoints = [
  ...fixedEntryPoints.map((entry) => ({ ...entry, stub: entry.file })),
  ...widgetEntryPoints,
];

// A previous run's output is an input as far as esbuild is concerned; drop it
// so a repeated build starts from the compiled tree alone.
await fs.rm(path.join(buildDir, BUNDLE_BASENAME), { force: true });

for (const { file } of entryPoints) {
  const contents = await fs.readFile(path.join(buildDir, file), 'utf8').catch(() => '');
  if (contents.includes(BUNDLE_BASENAME)) {
    fail(
      `${file} is already a bundle stub — \`.homeybuild\` holds a previous bundle `
      + 'without fresh tsc output. Remove `.homeybuild` and rebuild.',
    );
  }
}

for (const { file } of fixedEntryPoints) {
  const exists = await fs.stat(path.join(buildDir, file)).then(() => true).catch(() => false);
  // A renamed or removed entry point must not silently produce a bundle that
  // Homey cannot load; the app would boot-loop with MODULE_NOT_FOUND instead.
  if (!exists) fail(`entry point ${file} is missing from the build.`);
}

const beforeBytes = await byteSize(buildDir);

const syntheticPath = path.join(buildDir, SYNTHETIC_BASENAME);
const syntheticSource = `${entryPoints
  .map(({ file, key }) => `exports.${key} = require('./${file}');`)
  .join('\n')}\n`;
await fs.writeFile(syntheticPath, syntheticSource, 'utf8');

try {
  await esbuild.build({
    entryPoints: [syntheticPath],
    outfile: path.join(buildDir, BUNDLE_BASENAME),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    // Homey's SDK subclasses and reflects on Driver/Device/App class names;
    // mangling them changes what the platform and our own logs report.
    keepNames: true,
    // node_modules ships wholesale and is resolved at runtime. Inlining it
    // would duplicate pino/socket.io-client into the bundle.
    packages: 'external',
    logLevel: 'warning',
  });
} finally {
  await fs.rm(syntheticPath, { force: true });
}

for (const { stub, key } of entryPoints) {
  const absolute = path.join(buildDir, stub);
  const toBundle = path
    .relative(path.dirname(absolute), path.join(buildDir, BUNDLE_BASENAME))
    .split(path.sep)
    .join('/');
  const specifier = toBundle.startsWith('.') ? toBundle : `./${toBundle}`;
  await fs.writeFile(absolute, `module.exports = require('${specifier}').${key};\n`, 'utf8');
}

for (const dir of inlinedDirs) {
  await fs.rm(path.join(buildDir, dir), { recursive: true, force: true });
}

/**
 * Driver and widget directories keep their assets and their entry stubs; any
 * other compiled JS under them is now inlined in the bundle, and leaving a
 * second copy on disk would let a stray `require` load shared-domain twice.
 *
 * `widgets/<id>/public/` is skipped: that is the BROWSER bundle from
 * `scripts/build-widgets.mjs`, which never enters the app process.
 */
// The stubs are what Homey loads, so they survive; `widgets/<id>/src/api.js`
// deliberately does not — it is inlined in the bundle now.
const entryFiles = new Set(entryPoints.map(({ stub }) => path.join(buildDir, stub)));
const prunePackagedJs = async (absolute) => {
  let entries;
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const next = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'public') continue;
      await prunePackagedJs(next);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entryFiles.has(next)) {
      await fs.rm(next, { force: true });
    }
  }
};
await prunePackagedJs(path.join(buildDir, 'drivers'));
// Only when the widget lane actually ran — a bare `tsc` tree still has its
// widget sources reachable and must not be stripped of them.
if (widgetEntryPoints.length > 0) await prunePackagedJs(path.join(buildDir, 'widgets'));

const afterBytes = await byteSize(buildDir);
const bundleBytes = (await fs.stat(path.join(buildDir, BUNDLE_BASENAME))).size;
console.log(
  `bundle-homey-build: ${BUNDLE_BASENAME} ${mb(bundleBytes)}; `
  + `build ${mb(beforeBytes)} -> ${mb(afterBytes)}`,
);
