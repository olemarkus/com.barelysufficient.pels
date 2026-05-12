import path from 'node:path';
import process from 'node:process';
import { runParallel } from './lib/run-parallel.mjs';

const files = process.argv.slice(2)
  .map((file) => path.relative(process.cwd(), path.resolve(file)).replaceAll(path.sep, '/'))
  .filter((file) => file.endsWith('.ts') || file.endsWith('.mts'));

const matches = (prefixes) => files.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix)));

const commands = [];

if (matches([
  'app.ts',
  'api.ts',
  'drivers/',
  'flowCards/',
  'lib/',
  'test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
  'vitest.config.mts',
  'vitest.config.fast.mts',
  'vitest.config.dom.mts',
  'vitest.config.dom.fast.mts',
  'vitest.config.perf.mts',
  'vitest-env.d.ts',
])) {
  commands.push({ label: 'tsc:runtime', command: 'npx', args: ['tsc', '--noEmit'] });
}

if (matches([
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/settings-ui/tests/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
])) {
  commands.push({ label: 'tsc:settings-ui', command: 'npx', args: ['tsc', '-p', 'packages/settings-ui/tsconfig.json', '--noEmit'] });
}

if (matches(['widgets/'])) {
  commands.push({ label: 'tsc:widgets', command: 'npx', args: ['tsc', '-p', 'tsconfig.widgets.json', '--noEmit'] });
}

if (commands.length > 0) {
  await runParallel(commands);
}
