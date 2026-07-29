import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  MANIFEST_PATHS,
  matchesAnyPath,
  RUNTIME_PATHS,
  RUNTIME_TEST_WIRING_PATHS,
  selectMatchingPaths,
  SETTINGS_UI_UNIT_PATHS,
  SETTINGS_UI_TEST_WIRING_PATHS,
} from './lib/change-impact.mjs';
import { runSequential } from './lib/run-parallel.mjs';

const ZERO_SHA_PATTERN = /^0+$/;
const DRY_RUN = process.env.PELS_PRE_PUSH_DRY_RUN === '1';
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  const output = tryGit('diff', '--name-only', '--diff-filter=ACDMR', range);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const getDiffRangeForNewRemote = (localSha) => {
  const baseRef = getDefaultBaseRef();
  const mergeBase = tryGit('merge-base', localSha, baseRef);
  if (mergeBase) {
    return `${mergeBase}..${localSha}`;
  }

  const root = getRootCommit(localSha);
  if (!root) return null;
  return `${EMPTY_TREE_SHA}..${localSha}`;
};

const getDiffRangeForPush = ({ localSha, remoteSha }) => {
  if (!localSha || ZERO_SHA_PATTERN.test(localSha)) {
    return null;
  }

  if (!remoteSha || ZERO_SHA_PATTERN.test(remoteSha)) {
    return getDiffRangeForNewRemote(localSha);
  }

  return `${remoteSha}..${localSha}`;
};

const planCommands = (changedFiles, deletedFiles) => {
  const commands = [
    { label: 'ci:checks', command: 'npm', args: ['run', 'ci:checks'] },
  ];

  if (matchesAnyPath(changedFiles, RUNTIME_PATHS)) {
    const runtimeFiles = selectMatchingPaths(changedFiles, RUNTIME_PATHS);
    const hasWiringChange = matchesAnyPath(changedFiles, RUNTIME_TEST_WIRING_PATHS)
      || matchesAnyPath(deletedFiles, RUNTIME_PATHS);
    commands.push(hasWiringChange
      ? {
        label: 'test:runtime',
        command: 'npx',
        args: ['vitest', 'run', '--config', 'vitest.config.changed.mts'],
      }
      : {
        label: 'test:runtime:related',
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
    commands.push({
      label: hasWiringChange ? 'test:unit:tz' : 'test:unit:tz:related',
      command: 'node',
      args: hasWiringChange
        ? ['scripts/run-timezone-tests.mjs']
        : ['scripts/run-timezone-tests.mjs', '--related', ...runtimeFiles],
    });
  }

  if (matchesAnyPath(changedFiles, SETTINGS_UI_UNIT_PATHS)) {
    const settingsFiles = selectMatchingPaths(changedFiles, SETTINGS_UI_UNIT_PATHS)
      .map((file) => file.startsWith('packages/settings-ui/')
        ? file.slice('packages/settings-ui/'.length)
        : `../../${file}`);
    const hasWiringChange = matchesAnyPath(changedFiles, SETTINGS_UI_TEST_WIRING_PATHS)
      || matchesAnyPath(deletedFiles, SETTINGS_UI_UNIT_PATHS);
    commands.push(hasWiringChange
      ? {
        label: 'test:ui:unit',
        command: 'npm',
        args: ['--workspace', '@pels/settings-ui', 'exec', '--', 'vitest', 'run', '--config', 'vitest.config.ts'],
      }
      : {
        label: 'test:ui:unit:related',
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

  const ranges = pushRefs
    .map((ref) => getDiffRangeForPush(ref))
    .filter((range) => range !== null);
  const changedFiles = [...new Set(ranges.flatMap((range) => getChangedFilesForRange(range)))];
  if (changedFiles.length === 0) {
    console.log('pre-push: no changed files detected in pushed refs, skipping extra local checks');
    return;
  }

  console.log(`pre-push: inspecting ${changedFiles.length} changed file(s)`);

  const deletedFiles = [...new Set(ranges.flatMap((range) => {
    const output = tryGit('diff', '--name-only', '--diff-filter=D', range);
    return output?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  }))];
  const commands = planCommands(changedFiles, deletedFiles);
  announce(commands);

  if (DRY_RUN) return;

  await runSequential(commands);
};

await main();
