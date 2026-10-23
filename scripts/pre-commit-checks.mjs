import { runSequential } from './lib/run-parallel.mjs';

await runSequential([
  {
    // ESLint and tsc take the static-check lane of the validation lock, so
    // commits in several worktrees typecheck one at a time but never wait for
    // a test run.
    label: 'lint-staged',
    command: 'node',
    args: [
      'scripts/with-validation-lock.mjs',
      '--checks',
      'pre-commit:lint-staged',
      '--',
      'npx',
      'lint-staged',
      '--concurrent',
      'false',
    ],
  },
  {
    label: 'pre-commit:extra',
    command: 'node',
    args: ['scripts/pre-commit-extra-checks.mjs'],
  },
]);
