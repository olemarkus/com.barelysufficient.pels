import { runSequential } from './lib/run-parallel.mjs';

await runSequential([
  {
    label: 'lint-staged',
    command: 'npx',
    args: ['lint-staged', '--concurrent', 'false'],
  },
  {
    label: 'pre-commit:extra',
    command: 'node',
    args: ['scripts/pre-commit-extra-checks.mjs'],
  },
]);
