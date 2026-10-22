// Builds the standalone web app into `dist-remote/`, laid out as it is published:
//
//   index.html, launcher.js     the Homey list; works for every PELS version
//   versions.json               the PELS versions that have a build
//   v<version>/                 the settings UI of this PELS version
//
// A build is the same shell and styles as the Homey settings page, with
// Homey's injected `/homey.js` + `script.js` replaced by one `remote.js` that
// brings its own Web API client. Publishing adds this version's directory next
// to the ones already online and merges `versions.json`; `dist-remote/` holds
// only the current version. It is never copied into the Homey app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(packageDir, '..', '..');
const publicDir = path.join(packageDir, 'public');
const distDir = path.join(packageDir, 'dist');
const outDir = path.join(packageDir, 'dist-remote');

const { version } = JSON.parse(await fs.readFile(path.join(repoDir, '.homeycompose', 'app.json'), 'utf8'));
const versionDir = path.join(outDir, `v${version}`);

const HOMEY_SCRIPTS = '<script src="/homey.js" data-origin="settings"></script>\n  <script src="./script.js"></script>';
const SETTINGS_STYLESHEET = '<link rel="stylesheet" href="./style.css">';

const bundle = (entry, outfile, define = {}) => build({
  entryPoints: [path.join(packageDir, 'src', 'remote', entry)],
  bundle: true,
  outfile,
  format: 'iife',
  target: 'es2020',
  minify: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'warning',
  define,
});

// The stylesheet imports the generated design tokens, so both come from the built dist/.
const copyStyles = async (dir) => {
  for (const file of ['style.css', 'tokens.css']) {
    await fs.copyFile(path.join(distDir, file), path.join(dir, file));
  }
  await fs.copyFile(path.join(publicDir, 'webapp.css'), path.join(dir, 'webapp.css'));
};

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(versionDir, { recursive: true });

await bundle('launcherEntry.ts', path.join(outDir, 'launcher.js'));
await fs.copyFile(path.join(publicDir, 'webapp-launcher.html'), path.join(outDir, 'index.html'));
await copyStyles(outDir);
await fs.writeFile(path.join(outDir, 'versions.json'), `${JSON.stringify([version])}\n`);

await bundle('remoteEntry.ts', path.join(versionDir, 'remote.js'), {
  __PELS_WEB_APP_VERSION__: JSON.stringify(version),
});
const html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
if (!html.includes(HOMEY_SCRIPTS) || !html.includes(SETTINGS_STYLESHEET)) {
  throw new Error('public/index.html no longer loads style.css, /homey.js and script.js as build-remote expects');
}
await fs.writeFile(
  path.join(versionDir, 'index.html'),
  html
    .replace(HOMEY_SCRIPTS, '<script src="./remote.js"></script>')
    .replace(SETTINGS_STYLESHEET, `${SETTINGS_STYLESHEET}\n  <link rel="stylesheet" href="./webapp.css">`),
);
await copyStyles(versionDir);
