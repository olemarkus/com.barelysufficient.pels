import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  getTerminationExitCode,
  signalExitCode,
  spawnManagedChild,
} from './lib/managed-child.mjs';

const LOCK_HELD_ENV = 'PELS_VALIDATION_LOCK_HELD';
const LOCK_TIMEOUT_SECONDS = 30 * 60;
const LOCK_TIMEOUT_EXIT_CODE = 75;

const usage = () => {
  console.error('usage: node scripts/with-validation-lock.mjs <label> -- <command> [args...]');
};

const run = (command, args, env) => new Promise((resolve) => {
  const child = spawnManagedChild(command, args, {
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`validation lock: failed to start ${command}: ${error.message}`);
    resolve(1);
  });
  child.on('close', (code, signal) => {
    const terminationCode = getTerminationExitCode();
    if (terminationCode !== undefined) {
      resolve(terminationCode);
      return;
    }
    if (signal) {
      console.error(`validation lock: ${command} stopped by ${signal}`);
      resolve(signalExitCode(signal));
      return;
    }
    resolve(code ?? 1);
  });
});

// Locked runs get their own TMPDIR on disk. /tmp is RAM-backed on development
// hosts, and a killed Vitest run never removes its ~40 MB module dump there.
export const validationTmpRoot = (env = process.env) => path.join(
  env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'pels-validation-tmp',
);

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// A wrapper that was SIGKILLed leaves its run directory behind; the next run
// removes every directory whose owning wrapper is gone. A test process the dead
// wrapper orphaned loses its TMPDIR with it, which ends that stray run.
const removeOrphanedRunDirs = (tmpRoot) => {
  for (const entry of fs.readdirSync(tmpRoot)) {
    const pid = Number(entry.split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
    fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
  }
};

const withRunTmpDir = async (tmpRoot, env, runCommand) => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  removeOrphanedRunDirs(tmpRoot);
  const runDir = fs.mkdtempSync(path.join(tmpRoot, `${process.pid}-`));
  try {
    return await runCommand({ ...env, TMPDIR: runDir, PELS_CALLER_TMPDIR: os.tmpdir() });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
};

// On a desktop host the run gets a systemd user scope: above MemoryHigh the
// kernel reclaims and throttles the test run instead of swapping out the
// browser or editor, MemoryMax OOM-kills the run rather than something else,
// and the low CPU weight keeps the desktop responsive while it runs. The
// heaviest lane (Playwright, two browser workers) peaks around 1.7 GB. A run
// killed at MemoryMax fails like any crash; `journalctl --user` names the OOM.
const VALIDATION_SCOPE_PROPERTIES = [
  'MemoryHigh=3G',
  'MemoryMax=5G',
  'MemorySwapMax=1G',
  'CPUWeight=20',
];
const SYSTEMD_RUN_SCOPE_ARGS = ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no'];

const canRunInUserScope = (env) => {
  if (env.CI || env.PELS_VALIDATION_SCOPE === '0') return false;
  const probe = spawnSync('systemd-run', [...SYSTEMD_RUN_SCOPE_ARGS, '--', 'true'], { env, stdio: 'ignore' });
  return probe.status === 0;
};

export const validationLockPath = () => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('validation lock requires a Linux user id');
  }
  return `/tmp/pels-validation-${uid}.lock`;
};

export const runWithValidationLock = async ({
  label,
  command,
  args,
  env = process.env,
  platform = process.platform,
  timeoutSeconds = LOCK_TIMEOUT_SECONDS,
  lockPath: requestedLockPath,
  tmpRoot = validationTmpRoot(env),
}) => {
  if (env[LOCK_HELD_ENV] === '1') {
    return run(command, args, env);
  }

  return withRunTmpDir(tmpRoot, env, async (runEnv) => {
    if (platform !== 'linux') {
      console.warn('validation lock: flock unavailable; continuing with worker caps but no cross-worktree lock');
      return run(command, args, runEnv);
    }

    const lockPath = requestedLockPath ?? validationLockPath();
    console.log(`validation lock: ${label} waiting for the shared PELS validation slot`);
    const startedAt = Date.now();
    const flockArgs = [
      '--no-fork',
      '--exclusive',
      '--timeout',
      String(timeoutSeconds),
      '--conflict-exit-code',
      String(LOCK_TIMEOUT_EXIT_CODE),
      lockPath,
      command,
      ...args,
    ];
    const lockedEnv = { ...runEnv, [LOCK_HELD_ENV]: '1' };
    // systemd-run --scope execs in place, so signals still reach the process group.
    const code = canRunInUserScope(runEnv)
      ? await run('systemd-run', [
        ...SYSTEMD_RUN_SCOPE_ARGS,
        ...VALIDATION_SCOPE_PROPERTIES.flatMap((property) => ['-p', property]),
        '--',
        'flock',
        ...flockArgs,
      ], lockedEnv)
      : await run('flock', flockArgs, lockedEnv);

    if (code === LOCK_TIMEOUT_EXIT_CODE) {
      console.error(`validation lock: ${label} timed out after ${timeoutSeconds}s waiting for ${lockPath}`);
      return code;
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`validation lock: ${label} finished after ${elapsedSeconds}s including queue time`);
    return code;
  });
};

const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const separatorIndex = process.argv.indexOf('--', 2);
  if (separatorIndex !== 3 || process.argv.length < 5) {
    usage();
    process.exit(2);
  }

  const label = process.argv[2];
  const command = process.argv[4];
  const args = process.argv.slice(5);
  const code = await runWithValidationLock({ label, command, args });
  process.exit(code);
}
