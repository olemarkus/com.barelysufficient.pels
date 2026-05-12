import { runParallel } from './lib/run-parallel.mjs';

await runParallel([
  { label: 'tsc:runtime', command: 'npx', args: ['tsc', '--noEmit'] },
  { label: 'tsc:settings-ui', command: 'npx', args: ['tsc', '-p', 'packages/settings-ui/tsconfig.json', '--noEmit'] },
  { label: 'tsc:widgets', command: 'npx', args: ['tsc', '-p', 'tsconfig.widgets.json', '--noEmit'] },
  { label: 'tsc:unused', command: 'npm', args: ['run', 'typecheck:unused'] },
  { label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { label: 'lint:css', command: 'npm', args: ['run', 'lint:css'] },
  { label: 'lint:html', command: 'npm', args: ['run', 'lint:html'] },
  { label: 'arch', command: 'npm', args: ['run', 'arch:check'] },
  { label: 'deadcode', command: 'npm', args: ['run', 'deadcode:check'] },
]);
