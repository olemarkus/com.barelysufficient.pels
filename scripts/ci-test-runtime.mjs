import { runSequential } from './lib/run-parallel.mjs';
import { unitCiCommands } from './test-unit-ci.mjs';

await runSequential([
  ...unitCiCommands,
  { label: 'vitest:tz', command: 'node', args: ['scripts/run-timezone-tests.mjs'] },
]);
