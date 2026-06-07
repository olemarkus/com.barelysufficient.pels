import path from 'node:path';
import process from 'node:process';
import { runParallel } from './lib/run-parallel.mjs';

const files = process.argv.slice(2)
  .map((file) => path.relative(process.cwd(), path.resolve(file)).replaceAll(path.sep, '/'))
  .filter((file) => file.endsWith('.ts') || file.endsWith('.mts'));

const unique = (values) => [...new Set(values)];

const matches = (file, prefixes) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix));

const runtimeTestWiringFiles = [
  'vitest.shared.mts',
  'vitest.config.mts',
  'vitest.config.unit.mts',
  'vitest.config.integration.mts',
  'vitest.config.e2e.mts',
  'vitest.config.tz.mts',
  'vitest-env.d.ts',
];

const runtimeLaneConfigs = [
  ['unit', 'vitest.config.unit.mts'],
  ['integration', 'vitest.config.integration.mts'],
  ['e2e', 'vitest.config.e2e.mts'],
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
  for (const [tier, config] of runtimeLaneConfigs) {
    commands.push({ label: `vitest:${tier}`, command: 'npx', args: ['vitest', 'run', '--config', config] });
  }
} else if (runtimeFiles.length > 0) {
  for (const [tier, config] of runtimeLaneConfigs) {
    commands.push({
      label: `vitest:${tier}:related`,
      command: 'npx',
      args: ['vitest', 'related', '--config', config, '--passWithNoTests', ...runtimeFiles],
    });
  }
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
