import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const files = process.argv.slice(2)
  .map((file) => path.relative(process.cwd(), path.resolve(file)).replaceAll(path.sep, '/'))
  .filter((file) => file.endsWith('.ts'));

const unique = (values) => [...new Set(values)];

const matches = (file, prefixes) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix));

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

const runtimeFiles = unique(files.filter((file) => matches(file, runtimePrefixes)));
const settingsFiles = unique(files.filter((file) => matches(file, settingsPrefixes)))
  .map((file) => file.startsWith('packages/settings-ui/')
    ? file.slice('packages/settings-ui/'.length)
    : `../../${file}`);

const run = (command, args, options = {}) => {
  console.log(`pre-commit: running ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env, ...options });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status);
};

if (runtimeFiles.length > 0) {
  run('npx', [
    'vitest',
    'related',
    '--config',
    'vitest.config.fast.ts',
    '--passWithNoTests',
    ...runtimeFiles,
  ]);

  run('npx', [
    'vitest',
    'related',
    '--config',
    'vitest.config.dom.fast.ts',
    '--passWithNoTests',
    ...runtimeFiles,
  ]);
}

if (settingsFiles.length > 0) {
  run('npm', [
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
  ]);
}
