import process from 'node:process';
import {
  matchesAnyPath,
  normalizeRepositoryFiles,
  RUNTIME_PATHS,
  RUNTIME_TEST_WIRING_PATHS,
  selectMatchingPaths,
  SETTINGS_UI_UNIT_PATHS,
  SETTINGS_UI_TEST_WIRING_PATHS,
} from './lib/change-impact.mjs';
import { runSequential } from './lib/run-parallel.mjs';

const files = normalizeRepositoryFiles(process.argv.slice(2))
  .filter((file) => file.endsWith('.ts') || file.endsWith('.mts'));

const hasRuntimeTestWiringChange = matchesAnyPath(files, RUNTIME_TEST_WIRING_PATHS);
const runtimeFiles = selectMatchingPaths(files, RUNTIME_PATHS);
const settingsFiles = selectMatchingPaths(files, SETTINGS_UI_UNIT_PATHS)
  .map((file) => file.startsWith('packages/settings-ui/')
    ? file.slice('packages/settings-ui/'.length)
    : `../../${file}`);

const commands = [];

if (hasRuntimeTestWiringChange) {
  commands.push({
    label: 'vitest:runtime',
    command: 'npx',
    args: ['vitest', 'run', '--config', 'vitest.config.changed.mts'],
  });
} else if (runtimeFiles.length > 0) {
  commands.push({
    label: 'vitest:runtime:related',
    command: 'npx',
    args: [
      'vitest',
      'related',
      '--config',
      'vitest.config.changed.mts',
      '--passWithNoTests',
      ...runtimeFiles,
    ],
  });
}

if (settingsFiles.length > 0) {
  commands.push(matchesAnyPath(files, SETTINGS_UI_TEST_WIRING_PATHS)
    ? {
      label: 'vitest:settings-ui',
      command: 'npm',
      args: ['--workspace', '@pels/settings-ui', 'exec', '--', 'vitest', 'run', '--config', 'vitest.config.ts'],
    }
    : {
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
  await runSequential(commands);
}
