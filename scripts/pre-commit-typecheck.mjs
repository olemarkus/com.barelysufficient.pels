import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

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
  commands.push(['npx', ['tsc', '--noEmit']]);
}

if (matches([
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/settings-ui/tests/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
])) {
  commands.push(['npx', ['tsc', '-p', 'packages/settings-ui/tsconfig.json', '--noEmit']]);
}

if (matches(['widgets/'])) {
  commands.push(['npx', ['tsc', '-p', 'tsconfig.widgets.json', '--noEmit']]);
}

for (const [command, args] of commands) {
  console.log(`pre-commit: running ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status);
}
