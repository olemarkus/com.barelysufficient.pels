import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runParallel } from './lib/run-parallel.mjs';

const ZERO_SHA_PATTERN = /^0+$/;
const DRY_RUN = process.env.PELS_PRE_PUSH_DRY_RUN === '1';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  'vitest.shared.mts',
  'vitest.config.mts',
  'vitest.config.unit.mts',
  'vitest.config.integration.mts',
  'vitest.config.e2e.mts',
  'vitest.config.tz.mts',
  'vitest-env.d.ts',
];

const SETTINGS_UI_PATHS = [
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/settings-ui/package.json',
  'packages/contracts/src/',
  'packages/shared-domain/src/',
];

const MANIFEST_PATHS = [
  '.homeycompose/',
  'app.json',
  'drivers/',
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

const planCommands = (changedFiles) => {
  const commands = [
    { label: 'ci:checks', command: 'npm', args: ['run', 'ci:checks'] },
  ];

  if (matchesAnyPath(changedFiles, RUNTIME_PATHS)) {
    commands.push(
      { label: 'test:unit', command: 'npm', args: ['run', 'test:unit'] },
      { label: 'test:integration', command: 'npm', args: ['run', 'test:integration'] },
      { label: 'test:e2e:runtime', command: 'npm', args: ['run', 'test:e2e:runtime'] },
      { label: 'test:unit:tz', command: 'npm', args: ['run', 'test:unit:tz'] },
    );
  }

  if (matchesAnyPath(changedFiles, SETTINGS_UI_PATHS)) {
    commands.push({
      label: 'test:ui:unit',
      command: 'npm',
      args: ['--workspace', '@pels/settings-ui', 'exec', '--', 'vitest', 'run', '--config', 'vitest.config.ts'],
    });
  }

  if (matchesAnyPath(changedFiles, MANIFEST_PATHS)) {
    commands.push({ label: 'validate', command: 'npm', args: ['run', 'validate'] });
  }

  return commands;
};

const announce = (commands) => {
  for (const entry of commands) {
    console.log(`pre-push: running ${entry.command} ${entry.args.join(' ')}`);
  }
};

const main = async () => {
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

  const commands = planCommands(changedFiles);
  announce(commands);

  if (DRY_RUN) return;

  await runParallel(commands);
};

await main();
