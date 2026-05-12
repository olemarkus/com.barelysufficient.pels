import { runParallel } from './lib/run-parallel.mjs';

export const unitCiCommands = [
  { label: 'vitest:node', command: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.mts'] },
  { label: 'vitest:dom', command: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.dom.mts'] },
];

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  await runParallel(unitCiCommands);
}
