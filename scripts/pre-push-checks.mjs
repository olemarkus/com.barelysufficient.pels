import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const ZERO_SHA_PATTERN = /^0+$/;
const DRY_RUN = process.env.PELS_PRE_PUSH_DRY_RUN === '1';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const FULL_CI_PATHS = [
  '.github/workflows/',
  '.husky/',
  'package.json',
  'package-lock.json',
  'scripts/pre-push-checks.mjs',
];

const FULL_PLAYWRIGHT_PATHS = [
  'packages/settings-ui/package.json',
  'packages/settings-ui/playwright.config.ts',
  'packages/settings-ui/tests/e2e/',
  'scripts/playwright-static-server.mjs',
];

const QUICK_PLAYWRIGHT_PATHS = [
  'packages/settings-ui/public/',
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
  'scripts/sync-settings-ui.mjs',
  'settings/',
  'tokens/',
];

const RUNTIME_PATHS = [
  'app.ts',
  'api.ts',
  'drivers/',
  'flowCards/',
  'lib/',
  'test/',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
  'widgets/',
  'vitest.config.ts',
  'vitest.config.fast.ts',
  'vitest.config.dom.ts',
  'vitest.config.dom.fast.ts',
  'vitest-env.d.ts',
];

const VALIDATE_PATHS = [
  '.homeycompose/',
  'app.json',
  'drivers/',
  'flowCards/',
  'settings/',
  'widgets/',
  'scripts/check-homey-packaging.mjs',
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const parsePushRefs = () => {
  const input = readFileSync(0, 'utf8').trim();
  if (!input) return [];
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
};

const getDefaultBaseRef = () => tryGit('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD') ?? 'origin/main';

const getRootCommit = (sha) => {
  const root = tryGit('rev-list', '--max-parents=0', sha);
  if (!root) return null;
  return root
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? null;
};

const getChangedFilesForRange = (range) => {
  const output = tryGit('diff', '--name-only', '--diff-filter=ACMR', range);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const getChangedFilesForNewRemote = (localSha) => {
  const baseRef = getDefaultBaseRef();
  const mergeBase = tryGit('merge-base', localSha, baseRef);
  if (mergeBase) {
    return getChangedFilesForRange(`${mergeBase}..${localSha}`);
  }

  const root = getRootCommit(localSha);
  if (!root) return [];
  return getChangedFilesForRange(`${EMPTY_TREE_SHA}..${localSha}`);
};

const getChangedFilesForPush = ({ localSha, remoteSha }) => {
  if (!localSha || ZERO_SHA_PATTERN.test(localSha)) {
    return [];
  }

  if (!remoteSha || ZERO_SHA_PATTERN.test(remoteSha)) {
    return getChangedFilesForNewRemote(localSha);
  }

  return getChangedFilesForRange(`${remoteSha}..${localSha}`);
};

const matchesAnyPath = (files, patterns) => files.some((file) => (
  patterns.some((pattern) => file === pattern || file.startsWith(pattern))
));

const runCommand = (command, args) => {
  const rendered = `${command} ${args.join(' ')}`;
  console.log(`pre-push: running ${rendered}`);
  if (DRY_RUN) return;

  const result = spawnSync(command, args, {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
};

const runCommands = (commands) => {
  const seen = new Set();
  for (const [command, args] of commands) {
    const key = `${command}\0${args.join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runCommand(command, args);
  }
};

const main = () => {
  const pushRefs = parsePushRefs();
  if (pushRefs.length === 0) {
    console.log('pre-push: no refs received, skipping extra local checks');
    return;
  }

  const changedFiles = [...new Set(pushRefs.flatMap((ref) => getChangedFilesForPush(ref)))];
  if (changedFiles.length === 0) {
    console.log('pre-push: no changed files detected in pushed refs, skipping extra local checks');
    return;
  }

  console.log(`pre-push: inspecting ${changedFiles.length} changed file(s)`);

  if (matchesAnyPath(changedFiles, FULL_CI_PATHS)) {
    runCommand('npm', ['run', 'ci:full']);
    return;
  }

  const commands = [];

  if (matchesAnyPath(changedFiles, FULL_PLAYWRIGHT_PATHS)) {
    commands.push(
      ['npm', ['run', 'ci:test:settings-ui']],
      ['npm', ['run', 'ci:test:playwright']],
    );
  } else if (matchesAnyPath(changedFiles, QUICK_PLAYWRIGHT_PATHS)) {
    commands.push(
      ['npm', ['run', 'ci:test:settings-ui']],
      ['npm', ['run', 'ci:test:playwright:quick']],
    );
  }

  if (matchesAnyPath(changedFiles, RUNTIME_PATHS)) {
    commands.push(
      ['npm', ['run', 'lint:runtime']],
      ['npm', ['run', 'typecheck:unused']],
      ['npm', ['run', 'ci:test:runtime']],
    );
  }

  if (matchesAnyPath(changedFiles, VALIDATE_PATHS)) {
    commands.push(['npm', ['run', 'validate']]);
  }

  if (commands.length > 0) {
    runCommands(commands);
    return;
  }

  console.log('pre-push: no runtime, settings UI, packaging, or CI wiring changes detected; skipping extra local checks');
};

main();
