/**
 * Machine-wide advisory mutex for heavy local runs.
 *
 * Several PELS worktrees are usually live on one 8-core box. Vitest already
 * forks per tier and Playwright adds browser projects, so two concurrent runs
 * starve each other and produce failures that are indistinguishable from real
 * regressions. This module serializes those runs across worktrees.
 *
 * Mechanism: a JSON record staged and then `link()`ed into place under `/tmp`,
 * outside any repo, so every worktree contends for the same lock. link() fails
 * when the lock is held, and the entry is content-complete the instant it
 * becomes visible, so a waiter can never read a half-written record.
 *
 * A holder is considered abandoned — and its lock is taken over — when its pid
 * no longer answers `kill(pid, 0)`, when its record is unreadable, or when its
 * heartbeat (an mtime touch every HEARTBEAT_INTERVAL_MS) stopped more than
 * HEARTBEAT_GRACE_MS ago. The heartbeat is what covers pid reuse, where a dead
 * holder's pid has been handed to an unrelated long-lived process. A takeover
 * never empties the lock path (see `takeOver`), so it cannot hand the lock to a
 * bystander. `--release` is the break-glass for the case no rule can see, an
 * orphaned holder that is still heartbeating.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** `0` disables locking entirely (escape hatch); `1` forces it, even in CI. */
export const BYPASS_ENV = 'PELS_TEST_LOCK';
/** Token of the lock the current process tree already holds (re-entrancy). */
const OWNER_ENV = 'PELS_TEST_LOCK_OWNER';
/** Overrides the lock path. Used by the lock's own tests; keep it out of scripts. */
const LOCK_FILE_ENV = 'PELS_TEST_LOCK_FILE';
/** Overrides how long a waiter waits before giving up. */
const TIMEOUT_ENV = 'PELS_TEST_LOCK_TIMEOUT_MS';

/** EX_TEMPFAIL — deliberately not 1, so a lock timeout never reads as a test failure. */
export const LOCK_TIMEOUT_EXIT_CODE = 75;

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const CONTENTION_RETRY_MS = 50;
const NOTICE_INTERVAL_MS = 30_000;

/**
 * Test-only knobs so the heartbeat can be exercised in a second instead of two
 * minutes. Parsed leniently (a typo falls back to the default) because, unlike
 * the user-facing timeout, nothing outside this repo's own specs sets them.
 */
const readPositiveEnv = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEARTBEAT_INTERVAL_MS = readPositiveEnv('PELS_TEST_LOCK_HEARTBEAT_MS', 10_000);
const HEARTBEAT_GRACE_MS = readPositiveEnv('PELS_TEST_LOCK_GRACE_MS', 120_000);

const TRUE_FLAGS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_FLAGS = new Set(['0', 'false', 'off', 'no']);

export class TestLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestLockTimeoutError';
  }
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export const formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
};

/**
 * The lock is per-uid so a lock file owned by another user cannot wedge us on a
 * sticky /tmp. Every PELS worktree runs as the same user here, so per-uid is
 * machine-global in practice.
 */
export const resolveLockFile = (env = process.env) => {
  const override = env[LOCK_FILE_ENV];
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  // Deliberately NOT os.tmpdir(): that follows TMPDIR, and an agent session or
  // shell that exports its own scratchpad TMPDIR would get a private lock file,
  // silently turning the mutex off for that worktree only.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  return path.join(tempRoot, `pels-test-lock.${uid}.json`);
};

export const resolveTimeoutMs = ({ env = process.env, override } = {}) => {
  for (const candidate of [override, env[TIMEOUT_ENV]]) {
    if (candidate === undefined || candidate === null || String(candidate).trim() === '') continue;
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`invalid test-lock timeout ${JSON.stringify(String(candidate))} (expected milliseconds)`);
    }
    return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
};

const isCiEnvironment = (env) => {
  const raw = env.CI;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  return !FALSE_FLAGS.has(raw.trim().toLowerCase());
};

/** Whether this invocation should take the lock at all, and why. */
export const decideMode = (env = process.env) => {
  const raw = String(env[BYPASS_ENV] ?? '').trim().toLowerCase();
  if (FALSE_FLAGS.has(raw)) return { locking: false, reason: `${BYPASS_ENV}=${raw}` };
  if (TRUE_FLAGS.has(raw)) return { locking: true, reason: `${BYPASS_ENV}=${raw}` };
  if (isCiEnvironment(env)) return { locking: false, reason: 'CI' };
  return { locking: true, reason: 'default' };
};

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: still alive.
    return error.code === 'EPERM';
  }
};

const asRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null);

const asText = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback);

/** Resolves untrusted lock-file text into a holder record, or `null` if it is not one. */
const parseHolder = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.token !== 'string' || record.token === '') return null;
  return {
    token: record.token,
    pid: record.pid,
    label: asText(record.label, 'an unlabelled run'),
    cwd: asText(record.cwd, 'an unknown directory'),
    command: asText(record.command, 'unknown'),
    startedAtMs: Number.isFinite(record.startedAtMs) ? record.startedAtMs : null,
  };
};

/**
 * Reads the lock as a typed semantic state: `free`, `held` (a usable record),
 * or `corrupt` (a file exists but is not a holder record).
 */
export const readLock = (lockFile) => {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const heartbeatMs = fs.statSync(lockFile).mtimeMs;
    const holder = parseHolder(raw);
    if (holder === null) return { state: 'corrupt', heartbeatMs };
    return { state: 'held', holder, heartbeatMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'free' };
    throw error;
  }
};

/** Break-glass for an orphaned holder: drops the record whoever owns it. */
export const forceRelease = (lockFile) => {
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
};

export const isAbandoned = (status, nowMs = Date.now()) => {
  if (status.state === 'free') return false;
  const ageMs = nowMs - status.heartbeatMs;
  const heartbeatIsStale = ageMs > HEARTBEAT_GRACE_MS;
  if (status.state === 'corrupt') return heartbeatIsStale;
  // The dead-pid rule needs the record to be at least one heartbeat old: a
  // record published moments ago paired with a dead pid means we read a stale
  // record mid-handover, not that its owner crashed.
  const ownerIsGone = !isProcessAlive(status.holder.pid) && ageMs > HEARTBEAT_INTERVAL_MS;
  return ownerIsGone || heartbeatIsStale;
};

export const describeHolder = (status, nowMs = Date.now()) => {
  if (status.state === 'corrupt') return 'an unreadable lock record';
  if (status.state !== 'held') return 'nobody';
  const { holder } = status;
  const running = holder.startedAtMs === null ? 'unknown' : formatDuration(nowMs - holder.startedAtMs);
  return `${holder.label} in ${holder.cwd} (pid ${holder.pid}, running ${running})`;
};

/** Writes the record to a private path. Callers publish it with link() or rename(). */
const stageRecord = (lockFile, record) => {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const stagingPath = `${lockFile}.staging.${process.pid}.${record.token.slice(0, 8)}`;
  fs.writeFileSync(stagingPath, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  return stagingPath;
};

/**
 * Publishes the record atomically AND fully-formed. An `openSync(lockFile,'wx')`
 * followed by a write would leave a zero-byte window in which a polling waiter
 * reads an unparseable record and takes the lock away from the holder that is
 * still writing it. `link()` fails with EEXIST when the lock is taken, exactly
 * like `wx`, but the entry only becomes visible once the content is already there.
 */
const writeRecord = (lockFile, record) => {
  const stagingPath = stageRecord(lockFile, record);
  try {
    fs.linkSync(stagingPath, lockFile);
  } finally {
    fs.unlinkSync(stagingPath);
  }
};

/** Unpublishes the record, but only while it is still ours. */
const releaseRecord = (lockFile, token) => {
  try {
    const status = readLock(lockFile);
    if (status.state !== 'held' || status.holder.token !== token) return;
    fs.unlinkSync(lockFile);
  } catch {
    // Already gone, or taken over by someone else: nothing left to release.
  }
};

/** Whether two paths still name the same inode — the lock entry we linked, unchanged. */
const isSameEntry = (a, b) => {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.ino === right.ino && left.dev === right.dev;
  } catch {
    return false;
  }
};

/**
 * Takes an abandoned record over by SWAPPING our own record in, never by
 * removing theirs first.
 *
 * The removal-then-recreate shape is what breaks the mutex: it leaves the lock
 * path empty for a moment, and any ordinary waiter's `writeRecord` can link
 * itself in there while the previous holder is still running — two live holders,
 * one lock. So nothing here ever unlinks the lock entry:
 *
 *  1. `link()` the entry to a private probe path. Non-destructive: the record
 *     stays published, and the probe pins the exact inode we are judging.
 *  2. Confirm the probe holds the record we judged abandoned, and that the lock
 *     entry is still that same inode (a fresh record published under us has a
 *     different one, and is by definition too young to be abandoned).
 *  3. `rename()` our staged record over the entry. rename() replaces in one
 *     step, so the path is never empty and no bystander can slip in.
 *  4. Read back: the swap is only ours if our token is what is published.
 *
 * Returns whether we now hold the lock. What remains uncovered is two waiters
 * judging the *same* record abandoned and both reaching step 3 — POSIX offers no
 * compare-and-swap on a directory entry that Node exposes (`renameat2` is Linux
 * only), so step 2's inode re-check plus step 4's read-back narrow that to a
 * preemption between two adjacent syscalls rather than a window any acquire can
 * walk into.
 */
const takeOver = (lockFile, observedToken, record) => {
  const probePath = `${lockFile}.probe.${process.pid}.${record.token.slice(0, 8)}`;
  try {
    fs.linkSync(lockFile, probePath);
  } catch {
    // Freed or already replaced: the caller retries the plain exclusive create.
    return false;
  }
  let stagingPath = null;
  try {
    const pulled = parseHolder(fs.readFileSync(probePath, 'utf8'));
    const isTheRecordWeJudged = pulled === null ? observedToken === null : pulled.token === observedToken;
    if (!isTheRecordWeJudged) return false;
    // Staged BEFORE the last check so that check and the swap are adjacent
    // syscalls. Anything in between widens the window in which the entry we
    // verified could be released and legitimately re-taken by somebody else,
    // whose record the swap would then clobber.
    stagingPath = stageRecord(lockFile, record);
    if (!isSameEntry(lockFile, probePath)) return false;
    try {
      fs.renameSync(stagingPath, lockFile);
    } catch {
      return false;
    }
    stagingPath = null; // The rename consumed it.
    // Our record is published from here on, so every path out has to either
    // claim it or take it back down: a record we walk away from would hold the
    // lock with nobody left to release it.
    try {
      const published = readLock(lockFile);
      if (published.state === 'held' && published.holder.token === record.token) return true;
    } catch {
      // Fall through and drop it: an entry we cannot read is not one we can own.
    }
    releaseRecord(lockFile, record.token);
    return false;
  } catch {
    // Unreadable, or the entry went away under us: retry from the top.
    return false;
  } finally {
    // Both are private names derived from the lock path, never the lock entry.
    for (const scratch of [stagingPath, probePath]) {
      try {
        if (scratch !== null) fs.unlinkSync(scratch);
      } catch {
        // Best effort: nothing downstream ever reads these.
      }
    }
  }
};

const startHeartbeat = (lockFile, token) => {
  const timer = setInterval(() => {
    try {
      const status = readLock(lockFile);
      if (status.state !== 'held' || status.holder.token !== token) return;
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch {
      // Transient fs trouble: the next beat retries, and the grace window is wide.
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
};

const passThrough = (env) => ({ childEnv: { ...env }, release: () => {} });

/**
 * Nested invocations inside one process tree must never block on the lock their
 * own ancestor holds, or `npm run ci` deadlocks on itself. The inherited token
 * has to still match the live record — a stray descendant of a holder whose
 * lock has since been released or taken over acquires normally instead.
 */
const findInheritedHold = (env, lockFile) => {
  const inherited = env[OWNER_ENV];
  if (typeof inherited !== 'string' || inherited === '') return false;
  const status = readLock(lockFile);
  if (status.state !== 'held' || status.holder.token !== inherited) return false;
  return isProcessAlive(status.holder.pid);
};

const waitStep = ({ lockFile, status, makeRecord, deadlineMs, startMs, notice, log }) => {
  const nowMs = Date.now();
  if (isAbandoned(status, nowMs)) {
    log(`taking over ${describeHolder(status, nowMs)} (that run is gone)`);
    const observedToken = status.state === 'held' ? status.holder.token : null;
    const acquired = takeOver(lockFile, observedToken, makeRecord());
    return { delayMs: CONTENTION_RETRY_MS, acquired };
  }
  if (notice.lastMs === 0) {
    log(`waiting for the machine-wide test lock, held by ${describeHolder(status, nowMs)}`);
    if (status.state === 'held') log(`  command: ${status.holder.command}`);
    log(`  waiting up to ${formatDuration(deadlineMs - startMs)}; set ${BYPASS_ENV}=0 to bypass, Ctrl-C to abort`);
    notice.lastMs = nowMs;
  } else if (nowMs - notice.lastMs >= NOTICE_INTERVAL_MS) {
    log(`still waiting (${formatDuration(nowMs - startMs)}) for ${describeHolder(status, nowMs)}`);
    notice.lastMs = nowMs;
  }
  return { delayMs: POLL_INTERVAL_MS };
};

/**
 * Acquires the machine-wide test lock, waiting for a live holder to finish.
 *
 * Returns a handle whose `childEnv` must be handed to any spawned child, so the
 * whole process tree inherits the hold.
 */
export const acquireTestLock = async ({ label, command = '', timeoutMs, log = () => {} } = {}) => {
  const env = process.env;
  const lockFile = resolveLockFile();
  if (!decideMode().locking) return passThrough(env);
  if (findInheritedHold(env, lockFile)) return passThrough(env);

  const token = randomUUID();
  const startMs = Date.now();
  const deadlineMs = startMs + resolveTimeoutMs({ override: timeoutMs });
  const notice = { lastMs: 0 };
  const makeRecord = () => ({
    token,
    pid: process.pid,
    label: label ?? 'an unlabelled run',
    cwd: process.cwd(),
    command,
    startedAtMs: Date.now(),
  });

  for (;;) {
    try {
      writeRecord(lockFile, makeRecord());
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const status = readLock(lockFile);
    // Evaluated every iteration, not just when a live holder is in the way: a
    // takeover that can never succeed would otherwise spin without a deadline.
    const nowMs = Date.now();
    if (nowMs >= deadlineMs) {
      const blocker = status.state === 'free' ? 'the lock' : describeHolder(status, nowMs);
      throw new TestLockTimeoutError(`timed out after ${formatDuration(nowMs - startMs)} waiting for ${blocker}`);
    }
    if (status.state === 'free') {
      await sleep(CONTENTION_RETRY_MS);
      continue;
    }
    // A takeover publishes our record itself, so it can end the loop outright.
    const { delayMs, acquired } = waitStep({ lockFile, status, makeRecord, deadlineMs, startMs, notice, log });
    if (acquired === true) break;
    await sleep(delayMs);
  }

  if (notice.lastMs !== 0) log(`acquired after ${formatDuration(Date.now() - startMs)}`);

  const timer = startHeartbeat(lockFile, token);
  let released = false;
  return {
    childEnv: { ...env, [OWNER_ENV]: token },
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      releaseRecord(lockFile, token);
    },
  };
};
