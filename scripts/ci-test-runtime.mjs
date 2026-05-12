import { runParallel } from './lib/run-parallel.mjs';
import { unitCiCommands } from './test-unit-ci.mjs';

await runParallel([
  ...unitCiCommands,
  { label: 'vitest:tz', command: 'node', args: ['scripts/run-timezone-tests.mjs'] },
]);
