import path from 'node:path';
import process from 'node:process';
import { tscCheck } from './lib/local-check-cache.mjs';
import { runBounded } from './lib/run-parallel.mjs';

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
  'setup/',
  'test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
  'packages/planner-types/src/',
  'vitest.shared.mts',
  'vitest.config.mts',
  'vitest.config.unit.mts',
  'vitest.config.integration.mts',
  'vitest.config.e2e.mts',
  'vitest.config.tz.mts',
  'vitest-env.d.ts',
])) {
  commands.push(tscCheck('tsc:runtime'));
}

if (matches([
  'packages/settings-ui/src/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
])) {
  commands.push(tscCheck('tsc:settings-ui', ['-p', 'packages/settings-ui/tsconfig.json']));
}

// The src project covers `src/**` only, so a spec-only change needs the tests
// project or nothing typechecks the file that changed.
if (matches([
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/settings-ui/tests/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
])) {
  commands.push(tscCheck('tsc:settings-ui-tests', ['-p', 'packages/settings-ui/tsconfig.tests.json']));
}

if (matches(['widgets/'])) {
  commands.push(tscCheck('tsc:widgets', ['-p', 'tsconfig.widgets.json']));
}

if (commands.length > 0) {
  await runBounded(commands, 2);
}
