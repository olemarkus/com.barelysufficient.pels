import { eslintCacheArgs, tscCacheArgs, tscCheck } from './lib/local-check-cache.mjs';
import { runParallel } from './lib/run-parallel.mjs';

await runParallel([
  tscCheck('tsc:runtime'),
  tscCheck('tsc:settings-ui', ['-p', 'packages/settings-ui/tsconfig.json']),
  tscCheck('tsc:settings-ui-tests', ['-p', 'packages/settings-ui/tsconfig.tests.json']),
  tscCheck('tsc:widgets', ['-p', 'tsconfig.widgets.json']),
  tscCheck('tsc:shared-domain', ['-p', 'packages/shared-domain/tsconfig.json']),
  tscCheck('tsc:tests', ['-p', 'tsconfig.tests.json']),
  { label: 'tsc:unused', command: 'npm', args: ['run', 'typecheck:unused', '--', ...tscCacheArgs('tsc:unused')] },
  { label: 'lint', command: 'npm', args: ['run', 'lint', '--', ...eslintCacheArgs()] },
  { label: 'lint:css', command: 'npm', args: ['run', 'lint:css'] },
  { label: 'lint:html', command: 'npm', args: ['run', 'lint:html'] },
  { label: 'arch', command: 'npm', args: ['run', 'arch:check'] },
  { label: 'arch:grep', command: 'npm', args: ['run', 'arch:grep'] },
  { label: 'ev:vocab', command: 'npm', args: ['run', 'ev:vocab'] },
  { label: 'control-model:vocab', command: 'npm', args: ['run', 'control-model:vocab'] },
  { label: 'device-kind:vocab', command: 'npm', args: ['run', 'device-kind:vocab'] },
  { label: 'binary:vocab', command: 'npm', args: ['run', 'binary:vocab'] },
  { label: 'binary:seam', command: 'npm', args: ['run', 'binary:seam'] },
  { label: 'setup:stateless', command: 'npm', args: ['run', 'setup:stateless'] },
  { label: 'setup:boundaries', command: 'npm', args: ['run', 'setup:boundaries'] },
  { label: 'params:no-bundles', command: 'npm', args: ['run', 'params:no-bundles'] },
  { label: 'logging:no-legacy', command: 'npm', args: ['run', 'logging:no-legacy'] },
  { label: 'executor:plan-edge', command: 'npm', args: ['run', 'executor:plan-edge'] },
  { label: 'deadcode', command: 'npm', args: ['run', 'deadcode:check'] },
]);
