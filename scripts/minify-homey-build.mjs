#!/usr/bin/env node
/**
 * Minifies the compiled `.homeybuild/` module tree in place, one file at a
 * time, and deletes the compiled modules no entry point can reach.
 *
 * Why minify: V8 keeps every loaded script's source text on the heap for the
 * life of the process, so the bytes we ship are bytes we hold. Minified, the
 * reachable graph is ~2.3 MB of source instead of ~6.5 MB of tsc output.
 *
 * Why one file at a time and not one bundle: compiling a script mallocs parser
 * scratch roughly ten times its size, outside the V8 heap. For a single 2.3 MB
 * bundle that is one ~20 MB burst at boot, carved from glibc's main heap. V8
 * resizes its string table during that same compile, the new table lands above
 * the scratch, and glibc can only return memory from the top of the heap — so
 * the freed scratch stays resident for the life of the process. Measured with
 * the Homey app runtime's own Node 22.23.2 and glibc 2.36 in a local container,
 * loading the graph and forcing a full GC:
 *
 *                              anon     glibc heap   malloc peak   V8 heap
 *   one bundle (until now)   41.3 MB     23.0 MB       20.1 MB     14.7 MB
 *   per file, minified       23.1 MB      3.1 MB        2.2 MB     15.1 MB
 *   per file, plain tsc      30.9 MB      3.2 MB        2.2 MB     22.6 MB
 *
 * On a running Homey the same hole was 16 of the 24 MB glibc heap, and it was
 * most of the private-memory gap to comparable apps. Per-file compiles reuse
 * one small scratch allocation instead.
 *
 * Reachability comes from an esbuild bundle pass that is never written: its
 * metafile lists every module the entry points require. That keeps the package
 * as tree-shaken (at module granularity) as the bundle was, and makes a stray
 * `require` of a pruned module fail `check:homeybuild-requires` rather than
 * boot. The runtime has no dynamic requires, so the static graph is complete.
 *
 * Runs after `tsc` and before `sanitize:homey-build`. Bare specifiers stay
 * external: node_modules ships wholesale.
 */
import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(rootDir, '.homeybuild');

/**
 * The files Homey itself loads by path — `app.js` and `api.js` by convention,
 * driver/device via the driver id in app.json. Widget API entry points are
 * appended below: `widgets/<id>/api.js` is a committed shim that requires
 * `./src/api`, loaded by the widget runtime INSIDE the app process, so the
 * compiled `src/api.js` is the entry that matters.
 */
const fixedEntryPoints = [
  'app.js',
  'api.js',
  'drivers/pels_insights/driver.js',
  'drivers/pels_insights/device.js',
];

/**
 * Directories that hold only tsc output. `drivers/` and `widgets/` also hold
 * assets and browser bundles, which the walk below leaves alone; in all of
 * them, unreachable compiled `.js` is deleted.
 */
const compiledDirs = ['lib', 'setup', 'flowCards', 'packages'];

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const fail = (message) => {
  console.error(`minify-homey-build: ${message}`);
  process.exit(1);
};

const exists = (absolute) => fs.stat(absolute).then(() => true).catch(() => false);

if (!(await exists(buildDir))) fail(`${buildDir} does not exist — run \`tsc\` first.`);

/**
 * Widget ids come from the COMPILED tree — a `widgets/<id>/src/api.js` is what
 * makes a widget app-side, and tsc emits it in every build shape. CI runs
 * `npm run build` without the Homey CLI's source copy, so there is no app.json
 * in `.homeybuild` to read them from; when app.json is present it is still
 * cross-checked, because a widget that declares an API with no compiled
 * implementation would 404 at runtime with no build-time signal.
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
    if (await exists(path.join(buildDir, 'widgets', entry.name, 'src', 'api.js'))) ids.push(entry.name);
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

const entryPoints = [...fixedEntryPoints, ...widgetIds.map((id) => `widgets/${id}/src/api.js`)];
for (const file of fixedEntryPoints) {
  // A renamed or removed entry point must not silently produce a package that
  // Homey cannot load; the app would boot-loop with MODULE_NOT_FOUND instead.
  if (!(await exists(path.join(buildDir, file)))) fail(`entry point ${file} is missing from the build.`);
}

// keepNames records each function's CURRENT name, so a second pass over
// minified output would rename every class to its mangled identifier. tsc
// never emits esbuild's `configurable:!0` name helper; finding it means this
// tree has been minified already and needs fresh tsc output.
if ((await fs.readFile(path.join(buildDir, 'app.js'), 'utf8')).includes('configurable:!0')) {
  fail('`.homeybuild` is already minified. Run `tsc` (or `npm run build`) for fresh output.');
}

const { metafile } = await esbuild.build({
  absWorkingDir: buildDir,
  entryPoints,
  bundle: true,
  write: false,
  metafile: true,
  outdir: path.join(buildDir, '.reachability'),
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  logLevel: 'warning',
});
const reachable = new Set(Object.keys(metafile.inputs).map((input) => path.join(buildDir, input)));

let minifiedFiles = 0;
let prunedFiles = 0;
let bytesBefore = 0;
let bytesAfter = 0;

const minifyInPlace = async (absolute) => {
  const code = await fs.readFile(absolute, 'utf8');
  const result = await esbuild.transform(code, {
    loader: 'js',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    minify: true,
    // Homey's SDK subclasses and reflects on Driver/Device/App class names;
    // mangling them changes what the platform and our own logs report.
    keepNames: true,
    sourcefile: path.relative(buildDir, absolute),
  });
  await fs.writeFile(absolute, result.code, 'utf8');
  minifiedFiles += 1;
  bytesBefore += Buffer.byteLength(code);
  bytesAfter += Buffer.byteLength(result.code);
};

const processCompiledJs = async (absolute) => {
  if (reachable.has(absolute)) {
    await minifyInPlace(absolute);
  } else {
    await fs.rm(absolute, { force: true });
    prunedFiles += 1;
  }
};

/** The committed widget shims are not tsc output; they stay as they are. */
const widgetShims = new Set(widgetIds.map((id) => path.join(buildDir, 'widgets', id, 'api.js')));

/**
 * Walks a directory of compiled output. `public/` directories hold browser
 * bundles and static assets (the widgets', settings-ui's), never tsc output for
 * the app process, so they are left alone.
 */
const walkCompiled = async (absolute) => {
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
      if (entry.name !== 'public') await walkCompiled(next);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !widgetShims.has(next)) {
      await processCompiledJs(next);
    }
  }
};

for (const file of ['app.js', 'api.js']) await minifyInPlace(path.join(buildDir, file));
for (const dir of [...compiledDirs, 'drivers', 'widgets']) await walkCompiled(path.join(buildDir, dir));

console.log(
  `minify-homey-build: ${minifiedFiles} modules ${mb(bytesBefore)} -> ${mb(bytesAfter)}; `
  + `${prunedFiles} unreachable modules removed`,
);
