import path from 'node:path';
import process from 'node:process';
import { runParallel } from './lib/run-parallel.mjs';

const files = process.argv.slice(2)
  .map((file) => path.relative(process.cwd(), path.resolve(file)).replaceAll(path.sep, '/'))
  .filter((file) => file.endsWith('.ts') || file.endsWith('.mts'));

const unique = (values) => [...new Set(values)];

const matches = (file, prefixes) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix));

const runtimeTestWiringFiles = [
  'vitest.config.mts',
  'vitest.config.fast.mts',
  'vitest.config.dom.mts',
  'vitest.config.dom.fast.mts',
  'vitest-env.d.ts',
];

const runtimePrefixes = [
  'app.ts',
  'api.ts',
  'drivers/',
  'flowCards/',
  'lib/',
  'test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
  'widgets/',
];

const settingsPrefixes = [
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
];

const hasRuntimeTestWiringChange = files.some((file) => runtimeTestWiringFiles.includes(file));
const runtimeFiles = unique(files.filter((file) => matches(file, runtimePrefixes)));
const settingsFiles = unique(files.filter((file) => matches(file, settingsPrefixes)))
  .map((file) => file.startsWith('packages/settings-ui/')
    ? file.slice('packages/settings-ui/'.length)
    : `../../${file}`);

const commands = [];

if (hasRuntimeTestWiringChange) {
  commands.push(
    { label: 'vitest:node', command: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.fast.mts'] },
    { label: 'vitest:dom', command: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.dom.fast.mts'] },
  );
} else if (runtimeFiles.length > 0) {
  commands.push(
    {
      label: 'vitest:node:related',
      command: 'npx',
      args: ['vitest', 'related', '--config', 'vitest.config.fast.mts', '--passWithNoTests', ...runtimeFiles],
    },
    {
      label: 'vitest:dom:related',
      command: 'npx',
      args: ['vitest', 'related', '--config', 'vitest.config.dom.fast.mts', '--passWithNoTests', ...runtimeFiles],
    },
  );
}

if (settingsFiles.length > 0) {
  commands.push({
    label: 'vitest:settings-ui:related',
    command: 'npm',
    args: [
      '--workspace',
      '@pels/settings-ui',
      'exec',
      '--',
      'vitest',
      'related',
      '--config',
      'vitest.config.ts',
      '--passWithNoTests',
      ...settingsFiles,
    ],
  });
}

if (commands.length > 0) {
  await runParallel(commands);
}
