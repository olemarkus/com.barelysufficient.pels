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
}) => {
  if (env[LOCK_HELD_ENV] === '1') {
    return run(command, args, env);
  }

  if (platform !== 'linux') {
    console.warn('validation lock: flock unavailable; continuing with worker caps but no cross-worktree lock');
    return run(command, args, env);
  }

  const lockPath = requestedLockPath ?? validationLockPath();
  console.log(`validation lock: ${label} waiting for the shared PELS validation slot`);
  const startedAt = Date.now();
  const code = await run('flock', [
    '--no-fork',
    '--exclusive',
    '--timeout',
    String(timeoutSeconds),
    '--conflict-exit-code',
    String(LOCK_TIMEOUT_EXIT_CODE),
    lockPath,
    command,
    ...args,
  ], {
    ...env,
    [LOCK_HELD_ENV]: '1',
  });

  if (code === LOCK_TIMEOUT_EXIT_CODE) {
    console.error(`validation lock: ${label} timed out after ${timeoutSeconds}s waiting for ${lockPath}`);
    return code;
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`validation lock: ${label} finished after ${elapsedSeconds}s including queue time`);
  return code;
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
