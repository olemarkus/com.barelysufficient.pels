/**
 * Runs a command while holding the machine-wide test lock (scripts/lib/test-lock.mjs).
 *
 *   node scripts/with-test-lock.mjs [--label <name>] [--timeout-ms <n>] -- <command> [args...]
 *   node scripts/with-test-lock.mjs --status
 *
 * Silence on the happy path means the lock was free and was taken immediately.
 * Waiting, taking over an abandoned lock, and timing out all report on stderr.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  BYPASS_ENV,
  LOCK_TIMEOUT_EXIT_CODE,
  TestLockTimeoutError,
  acquireTestLock,
  decideMode,
  describeHolder,
  formatDuration,
  isAbandoned,
  forceRelease,
  readLock,
  resolveLockFile,
  resolveTimeoutMs,
} from './lib/test-lock.mjs';

const USAGE = [
  'usage: node scripts/with-test-lock.mjs [--label <name>] [--timeout-ms <n>] -- <command> [args...]',
  '       node scripts/with-test-lock.mjs --status',
  '       node scripts/with-test-lock.mjs --release   (break-glass: drop a stuck record)',
].join('\n');

const log = (message) => console.error(`pels-test-lock: ${message}`);
const say = (message) => console.log(`pels-test-lock: ${message}`);

const parseArgs = (argv) => {
  const options = { label: undefined, timeoutMs: undefined, status: false, release: false };
  const command = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      command.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--status' || arg === '--release') {
      options[arg === '--status' ? 'status' : 'release'] = true;
      index += 1;
    } else if (arg === '--label' || arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      if (arg === '--label') options.label = value;
      else options.timeoutMs = value;
      index += 2;
    } else {
      throw new Error(`unknown option ${arg}\n${USAGE}`);
    }
  }
  return { ...options, command };
};

const resolveLabel = (options) => {
  if (typeof options.label === 'string' && options.label !== '') return options.label;
  const lifecycle = process.env.npm_lifecycle_event;
  if (typeof lifecycle === 'string' && lifecycle !== '') return lifecycle;
  return path.basename(options.command[0]);
};

const printStatus = () => {
  const lockFile = resolveLockFile();
  const mode = decideMode();
  say(`lock file: ${lockFile}`);
  if (!mode.locking) say(`locking is DISABLED in this shell (${mode.reason})`);

  const status = readLock(lockFile);
  const nowMs = Date.now();
  if (status.state === 'free') {
    say('free: no run holds the lock');
    return;
  }
  say(`held by ${describeHolder(status, nowMs)}`);
  if (status.state === 'held') say(`  command: ${status.holder.command || 'unknown'}`);
  say(`  heartbeat: ${formatDuration(nowMs - status.heartbeatMs)} ago`);
  if (isAbandoned(status, nowMs)) say('  that holder is gone, so the next run takes the lock over');
};

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Process groups are POSIX. On Windows `detached` opens a new console and there
 * is no `kill(-pgid)`, so there the wrapper signals the direct child and the
 * process-tree guarantee below is not available.
 */
const USE_PROCESS_GROUP = process.platform !== 'win32';

/** Escalation budget per signal when a run leaves processes behind. */
const GROUP_DRAIN_MS = 2000;
const GROUP_POLL_MS = 50;

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * For the one case no staleness rule can detect: a holder that was orphaned from
 * its supervisor (killing a Volta shim leaves the real wrapper running) and so
 * keeps heartbeating a lock nobody is waiting on any more.
 */
const releaseStuckLock = () => {
  const lockFile = resolveLockFile();
  const status = readLock(lockFile);
  if (status.state === 'free') {
    say('free already: nothing to release');
    return;
  }
  say(`releasing the lock held by ${describeHolder(status)}`);
  if (status.state === 'held') say(`  if that run is still going, stop it first: kill ${status.holder.pid}`);
  say(forceRelease(lockFile) ? '  released' : '  could not remove the record');
};

/** True while any member of the process group can still be signalled. */
const groupIsAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but belongs to another user: still alive.
    return error.code === 'EPERM';
  }
};

/**
 * Releasing the lock has to mean "nothing from this run is left running", and
 * the command's own exit does not prove that: `-- npm run ci:steps` exits when
 * npm does, while the vitest workers it spawned can outlive it. A surviving
 * suite next to a free lock is exactly the collision this wrapper exists to
 * prevent, so wind the whole group down before the caller releases.
 *
 * Reaping leftovers is the intent, not collateral damage: a background process
 * that outlives a test run is contention for whoever holds the lock next.
 *
 * The pgid is the exited command's pid, so in principle a recycled pid could name
 * an unrelated group. Accepted: pid allocation here is sequential up to a 4M
 * pid_max, and the probe runs microseconds after the child is reaped.
 */
const stopGroup = async (pgid) => {
  if (!groupIsAlive(pgid)) return;
  log('the run left processes behind; stopping them before releasing the lock');
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Raced us to exit; the poll below is what decides.
    }
    const deadlineMs = Date.now() + GROUP_DRAIN_MS;
    while (Date.now() < deadlineMs) {
      if (!groupIsAlive(pgid)) return;
      await sleep(GROUP_POLL_MS);
    }
  }
  log(`some processes from this run survived SIGKILL; inspect them with \`ps -g ${pgid}\``);
};

// Deliberately not scripts/lib/run-parallel.mjs's runOne: that pipes stdio through
// a line prefixer and exits the process itself, while a lock wrapper needs
// `stdio: 'inherit'` (vitest/Playwright TTY output), a custom env, signal
// forwarding, and the child's exit code returned rather than acted on.
const runChild = (command, childEnv) => new Promise((resolve) => {
  // `detached` is setsid(): the command leads a new process group AND a new
  // session. The group is the only way to reach its descendants — `child.kill()`
  // signals npm but not the vitest workers underneath it. The trade is that the
  // command leaves this terminal's foreground group, so no terminal signal
  // (Ctrl-C, hangup) reaches it directly any more; every one has to be forwarded
  // below. AGENTS.md lists what else the new session costs.
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: childEnv,
    detached: USE_PROCESS_GROUP,
  });

  // Forward and then wait for the child: releasing the lock before it exits
  // would let a waiter start against a still-running suite.
  const forward = (signal) => () => {
    if (typeof child.pid !== 'number') return;
    try {
      if (USE_PROCESS_GROUP) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone between the command exiting and this signal arriving.
    }
  };
  const handlers = FORWARDED_SIGNALS.map((signal) => [signal, forward(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  // The handlers stay installed across the drain. Dropping them first would give
  // the wrapper default signal disposition for up to GROUP_DRAIN_MS x 2: a Ctrl-C
  // landing there kills it outright, so the escalation never finishes and the
  // `exit` release never runs — leftovers alive AND the record stranded, which is
  // both halves of the guarantee at once. Re-signalling a group already being
  // torn down is harmless.
  // Never let teardown trouble strand the promise either: an unresolved settle()
  // would hang the wrapper holding the lock, worse than any leftover process.
  const settle = async (code) => {
    try {
      if (USE_PROCESS_GROUP && typeof child.pid === 'number') await stopGroup(child.pid);
    } catch (error) {
      log(`could not confirm the run's processes are gone (${error.message})`);
    }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    resolve(code);
  };

  child.on('error', (error) => {
    log(`failed to run ${command[0]}: ${error.message}`);
    void settle(127);
  });
  child.on('close', (code, signal) => {
    void settle(typeof signal === 'string' ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 1);
  });
});

/**
 * Fails open on lock machinery trouble (an unwritable tmpdir, a lock path that
 * is somehow a directory). This is an advisory mutex: refusing to run any test
 * on this machine would be a worse outcome than the contention it prevents, and
 * the warning says so out loud. A timeout is not machinery trouble — a live
 * holder still owns the box, so that one propagates.
 */
const acquireOrWarn = async (options, timeoutMs) => {
  try {
    return await acquireTestLock({
      label: resolveLabel(options),
      command: options.command.join(' '),
      timeoutMs,
      log,
    });
  } catch (error) {
    if (error instanceof TestLockTimeoutError) throw error;
    log(`could not use the lock (${error.message}); running UNLOCKED`);
    return { childEnv: { ...process.env }, release: () => {} };
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.status) {
    printStatus();
    return 0;
  }
  if (options.release) {
    releaseStuckLock();
    return 0;
  }
  if (options.command.length === 0) throw new Error(`no command given\n${USAGE}`);

  // Validated before the fail-open guard below: a malformed timeout is a typo to
  // report, not filesystem trouble to shrug off by running unlocked.
  const timeoutMs = resolveTimeoutMs({ override: options.timeoutMs });
  const handle = await acquireOrWarn(options, timeoutMs);
  process.on('exit', handle.release);

  const exitCode = await runChild(options.command, handle.childEnv);
  handle.release();
  return exitCode;
};

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof TestLockTimeoutError) {
    log(error.message);
    log(`run \`npm run test:lock:status\` for details, or set ${BYPASS_ENV}=0 to bypass`);
    process.exitCode = LOCK_TIMEOUT_EXIT_CODE;
  } else {
    log(error.message);
    process.exitCode = 1;
  }
}
