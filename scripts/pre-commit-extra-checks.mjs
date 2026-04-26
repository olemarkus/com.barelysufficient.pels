import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const getStagedFiles = () => {
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const hasStagedFile = (files, paths) => files.some((file) => paths.includes(file));

const run = (command, args) => {
  console.log(`pre-commit-extra: running ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status);
};

const stagedFiles = getStagedFiles();
const commands = [];

if (hasStagedFile(stagedFiles, ['.husky/pre-commit', 'scripts/pre-commit-extra-checks.mjs', 'scripts/pre-push-checks.mjs'])) {
  commands.push(['npx', ['vitest', 'run', '--config', 'vitest.config.fast.mts', 'test/prePushChecks.test.ts']]);
}

if (hasStagedFile(stagedFiles, ['.husky/pre-commit', 'scripts/pre-commit-extra-checks.mjs', 'scripts/pre-commit-typecheck.mjs'])) {
  commands.push(['node', ['scripts/pre-commit-typecheck.mjs', 'test/prePushChecks.test.ts']]);
}

if (hasStagedFile(stagedFiles, ['.husky/pre-commit', 'scripts/pre-commit-extra-checks.mjs', 'scripts/pre-commit-tests.mjs'])) {
  commands.push(['node', ['scripts/pre-commit-tests.mjs', 'test/prePushChecks.test.ts']]);
}

if (commands.length === 0) {
  console.log('pre-commit-extra: no hook or test-routing changes detected');
}

const seen = new Set();
for (const [command, args] of commands) {
  const key = `${command}\0${args.join('\0')}`;
  if (seen.has(key)) continue;
  seen.add(key);
  run(command, args);
}
