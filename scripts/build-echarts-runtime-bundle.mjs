import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const entry = path.join(rootDir, 'lib/insights/echartsRuntimeEntry.mjs');
const outfile = path.join(rootDir, 'lib/insights/echartsRuntimeBundle.cjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});
