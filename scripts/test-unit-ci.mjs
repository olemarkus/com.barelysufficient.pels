import { runParallel } from './lib/run-parallel.mjs';

// Coverage lane: every runtime tier (unit + integration + e2e, plus jsdom widget
// specs that self-declare their environment) in one instrumented pass that
// enforces the 80% threshold.
export const unitCiCommands = [
  { label: 'vitest:coverage', command: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.mts'] },
];

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  await runParallel(unitCiCommands);
}
