import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '../..');
const wrapper = path.join(repoRoot, 'scripts/with-test-lock.mjs');

let lockDir: string;
let lockFile: string;
let markerFile: string;
const running: ChildProcess[] = [];

// The suite itself usually runs under the wrapper, so the inherited hold, the CI
// flag, and any bypass must be scrubbed or every case would pass straight through.
// PELS_TEST_LOCK_TIMEOUT_MS is overridden rather than deleted: a spawnSync that
// blocked on the real 60-minute default would outlive vitest's own test timeout.
const baseEnv = (): NodeJS.ProcessEnv => {
  if (lockFile === undefined) throw new Error('lockFile is only set in beforeEach');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PELS_TEST_LOCK_FILE: lockFile,
    PELS_TEST_LOCK_TIMEOUT_MS: '5000',
  };
  delete env.PELS_TEST_LOCK_OWNER;
  delete env.PELS_TEST_LOCK;
  delete env.PELS_TEST_LOCK_HEARTBEAT_MS;
  delete env.PELS_TEST_LOCK_GRACE_MS;
  delete env.CI;
  return env;
};

const runWrapper = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(
  process.execPath,
  [wrapper, ...args],
  { cwd: repoRoot, encoding: 'utf8', env: { ...baseEnv(), ...env } },
);

const startWrapper = (args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess => {
  const child = spawn(process.execPath, [wrapper, ...args], {
    cwd: repoRoot,
    env: { ...baseEnv(), ...env },
    stdio: 'ignore',
  });
  running.push(child);
  return child;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForFile = async (file: string, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(20);
  }
  return false;
};

const waitForLock = (timeoutMs = 5000): Promise<boolean> => waitForFile(lockFile, timeoutMs);

/**
 * A pid stays signalable as a zombie until whoever adopted it reaps, so "the
 * wrapper stopped it" is a poll, not an instant.
 */
const waitForPidGone = async (pid: number, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(20);
  }
  return false;
};

const waitForExit = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.on('close', () => resolve());
});

const writeHolder = (overrides: Record<string, unknown> = {}) => {
  fs.writeFileSync(lockFile, `${JSON.stringify({
    token: 'holder-token',
    pid: process.pid,
    label: 'fake:holder',
    cwd: '/home/someone/dev/pels-other',
    command: 'vitest run --config vitest.config.mts',
    startedAtMs: Date.now(),
    ...overrides,
  })}\n`);
};

const ageLockFile = (ms: number) => {
  const seconds = (Date.now() - ms) / 1000;
  fs.utimesSync(lockFile, seconds, seconds);
};

/** A pid that is guaranteed dead: a child we spawned and reaped. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid as number;

/** Stays alive until afterEach kills it, so no test races a holder's own exit. */
const sleeper = ['-e', 'setTimeout(() => {}, 60_000)'];

/** Appends `<name>-start`, waits, appends `<name>-end`: proves runs did not overlap. */
const marker = (name: string, holdMs: number) => [
  '-e',
  'const fs = require(\'fs\');'
  + `fs.appendFileSync(process.env.MARKER_FILE, '${name}-start\\n');`
  + `setTimeout(() => fs.appendFileSync(process.env.MARKER_FILE, '${name}-end\\n'), ${holdMs});`,
];

const readMarkers = (): string[] => (fs.existsSync(markerFile)
  ? fs.readFileSync(markerFile, 'utf8').split('\n').filter(Boolean)
  : []);

beforeEach(() => {
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-test-lock-spec-'));
  lockFile = path.join(lockDir, 'lock.json');
  markerFile = path.join(lockDir, 'markers.log');
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill('SIGTERM');
    await waitForExit(child);
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
});

describe('machine-wide test lock', () => {
  it('acquires the lock, runs the command, and releases it', () => {
    const result = runWrapper([
      '--label', 'spec:acquire', '--', process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('propagates the command exit code', () => {
    const result = runWrapper(['--label', 'spec:exit', '--', process.execPath, '-e', 'process.exit(3)']);

    expect(result.status).toBe(3);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('reports a signal-killed command as 128 + signal rather than success', () => {
    const result = runWrapper([
      '--label', 'spec:signal', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")',
    ]);

    expect(result.status).toBe(137);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('releases the lock when the command cannot be spawned at all', () => {
    const result = runWrapper(['--label', 'spec:enoent', '--', 'pels-definitely-not-a-command']);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('failed to run');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('serializes two runs: the waiter never overlaps the holder', async () => {
    const holder = startWrapper(
      ['--label', 'spec:holder', '--', process.execPath, ...marker('holder', 800)],
      { MARKER_FILE: markerFile },
    );
    expect(await waitForLock()).toBe(true);

    const waiter = runWrapper(
      ['--label', 'spec:waiter', '--', process.execPath, ...marker('waiter', 0)],
      { MARKER_FILE: markerFile },
    );

    expect(waiter.status).toBe(0);
    await waitForExit(holder);
    expect(readMarkers()).toEqual(['holder-start', 'holder-end', 'waiter-start', 'waiter-end']);
  });

  it('names the holder and exits with the lock-timeout code instead of running', async () => {
    startWrapper(['--label', 'spec:holder', '--', process.execPath, ...sleeper]);
    expect(await waitForLock()).toBe(true);

    const result = runWrapper([
      '--label', 'spec:waiter', '--timeout-ms', '300', '--',
      process.execPath, '-e', 'process.stdout.write("should not run")',
    ]);

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('should not run');
    expect(result.stderr).toContain('waiting for the machine-wide test lock');
    expect(result.stderr).toContain('spec:holder');
    expect(result.stderr).toContain('timed out');
  });

  it('keeps the lock alive while it runs, so a long holder is never taken over', async () => {
    // The grace window is deliberately SHORTER than the hold below: a record that
    // stopped beating would be past it and taken over, so the waiter's refusal is
    // evidence of a live heartbeat rather than of a window it never left.
    const heartbeat = { PELS_TEST_LOCK_HEARTBEAT_MS: '50', PELS_TEST_LOCK_GRACE_MS: '1000' };
    startWrapper(['--label', 'spec:long', '--', process.execPath, ...sleeper], heartbeat);
    expect(await waitForLock()).toBe(true);
    const firstBeat = fs.statSync(lockFile).mtimeMs;

    await sleep(1500);

    expect(fs.statSync(lockFile).mtimeMs).toBeGreaterThan(firstBeat);
    const result = runWrapper(
      [
        '--label', 'spec:waiter', '--timeout-ms', '300', '--',
        process.execPath, '-e', 'process.stdout.write("stole it")',
      ],
      heartbeat,
    );
    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('stole it');
    expect(result.stderr).not.toContain('taking over');
  });

  it('takes the same lock over once the heartbeat it was proven against stops', async () => {
    // The control for the case above: identical timings, but nothing beats the
    // record, so the very same 1500 ms hold does put it past the grace window.
    const heartbeat = { PELS_TEST_LOCK_HEARTBEAT_MS: '50', PELS_TEST_LOCK_GRACE_MS: '1000' };
    writeHolder({ label: 'stopped:beating' });

    await sleep(1500);

    const result = runWrapper(
      [
        '--label', 'spec:waiter', '--timeout-ms', '2000', '--',
        process.execPath, '-e', 'process.stdout.write("ran")',
      ],
      heartbeat,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran');
    expect(result.stderr).toContain('taking over stopped:beating');
  });

  it('stops processes the run left behind before releasing the lock', async () => {
    // A released lock next to a live suite is the collision the lock exists to
    // prevent, so the wrapper may only release once nothing from the run is left.
    // `npm run ci:steps` is this shape: the command exits while its workers do not.
    const pidFile = path.join(lockDir, 'grandchild.pid');
    const result = runWrapper(
      [
        '--label', 'spec:tree', '--', process.execPath, '-e',
        'const { spawn } = require(\'child_process\');'
        + 'const left = spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 60_000)\'], { stdio: \'ignore\' });'
        + 'require(\'fs\').writeFileSync(process.env.PID_FILE, String(left.pid));'
        + 'left.unref();',
      ],
      { PID_FILE: pidFile },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('stopping them before releasing the lock');
    expect(fs.existsSync(lockFile)).toBe(false);
    // Would still have 60 s to live if the wrapper had only signalled its own child.
    expect(await waitForPidGone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  });

  it('leaves nothing of the run alive when it is torn down by a signal', async () => {
    // Asserts the END STATE, not which mechanism produced it. Signal forwarding
    // and the pre-release drain are deliberately redundant here — either alone
    // reaches this grandchild — so no CLI-level observation can tell them apart,
    // and the one that could (the drain log's absence) is a race: under load the
    // probe sees processes that are signalled but not yet reaped, and the drain
    // announces itself for a group that was already on its way out. Coverage that
    // separates the two paths needs a direct call; tracked in TODO.md.
    const pidFile = path.join(lockDir, 'grandchild.pid');
    const holder = startWrapper(
      [
        '--label', 'spec:forward', '--', process.execPath, '-e',
        'const { spawn } = require(\'child_process\');'
        + 'const kid = spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 60_000)\'], { stdio: \'ignore\' });'
        + 'require(\'fs\').writeFileSync(process.env.PID_FILE, String(kid.pid));'
        + 'setTimeout(() => {}, 60_000);',
      ],
      { PID_FILE: pidFile },
    );
    expect(await waitForLock()).toBe(true);
    // Signal the wrapper at the pid it recorded, not the one we spawned: `node`
    // is a Volta shim here that forwards nothing, so signalling the shim would
    // just orphan the wrapper behind it.
    const wrapperPid = Number(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid);
    // The record lands before the command runs, so wait for the tree to be there.
    expect(await waitForFile(pidFile)).toBe(true);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));

    process.kill(wrapperPid, 'SIGTERM');
    await waitForExit(holder);

    // Would have 60 s left to live if teardown had stopped at the direct child
    // and the wrapper had released on top of it.
    expect(await waitForPidGone(grandchild)).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 60_000);

  it('hands an abandoned record to exactly one of a crowd of waiters at a time', async () => {
    // Takeover under real contention: every waiter judges the same stale record
    // abandoned at once, so while one is mid-takeover the others are hammering the
    // exclusive create. This does NOT prove the swap is gap-free — a crowd all
    // judging one DEAD record cannot reach that branch (it needs a mis-judged live
    // record), and this passes against the old removal-based takeover too. It
    // guards the outcome: whatever the takeover does, one of the crowd at a time.
    writeHolder({ pid: deadPid(), label: 'crashed:run' });
    ageLockFile(30_000);

    // A generous lock timeout on purpose. Six wrappers queueing behind each other
    // is slow when the box is loaded, and a waiter that gives up at exit 75 writes
    // no marker at all -- which would fail this on count while proving nothing
    // about overlap, the property under test. Waiting longer cannot mask a bug
    // here: overlap shows up as ordering, never as a missing pair.
    const crowd = [1, 2, 3, 4, 5, 6].map((n) => startWrapper(
      ['--label', `spec:crowd${n}`, '--timeout-ms', '60000', '--', process.execPath, ...marker(`run${n}`, 60)],
      { MARKER_FILE: markerFile },
    ));
    for (const runner of crowd) await waitForExit(runner);

    const markers = readMarkers();
    expect(markers).toHaveLength(12);
    // Strict start/end pairing: any overlap shows up as two starts in a row.
    for (let index = 0; index < markers.length; index += 2) {
      expect(markers[index + 1]).toBe(markers[index].replace('-start', '-end'));
    }
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 90_000);

  it('leaves no staging or probe files behind after a takeover', () => {
    // Guards the `finally` cleanup of the private paths the swap needs; a leak
    // here would litter the shared /tmp every worktree contends on.
    writeHolder({ pid: deadPid(), label: 'crashed:run' });
    ageLockFile(30_000);

    const result = runWrapper([
      '--label', 'spec:tidy', '--timeout-ms', '2000', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('taking over crashed:run');
    expect(fs.readdirSync(lockDir).filter((name) => name.startsWith('lock.json'))).toEqual([]);
  });

  it('reports who holds the lock, with worktree, label and age', async () => {
    startWrapper(['--label', 'spec:holder', '--', process.execPath, ...sleeper]);
    expect(await waitForLock()).toBe(true);

    const status = runWrapper(['--status']);

    expect(status.status).toBe(0);
    expect(status.stdout).toContain('held by spec:holder');
    expect(status.stdout).toContain(repoRoot);
    expect(status.stdout).toContain('running ');
    expect(status.stdout).toContain('heartbeat:');
  });

  it('names the holder after the npm script that started it', async () => {
    startWrapper(['--', process.execPath, ...sleeper], { npm_lifecycle_event: 'test:coverage' });
    expect(await waitForLock()).toBe(true);

    expect(runWrapper(['--status']).stdout).toContain('held by test:coverage');
  });

  it('reports a free lock', () => {
    const status = runWrapper(['--status']);

    expect(status.status).toBe(0);
    expect(status.stdout).toContain('free: no run holds the lock');
  });

  it('defaults to a per-user path under the system temp dir, not the repo', () => {
    const env = baseEnv();
    delete env.PELS_TEST_LOCK_FILE;
    const status = spawnSync(process.execPath, [wrapper, '--status'], { cwd: repoRoot, encoding: 'utf8', env });

    // Read-only: --status never creates or mutates the real machine lock. Only the
    // path line is asserted -- the holder line legitimately names this worktree,
    // because the suite itself usually runs under the wrapper.
    expect(status.status).toBe(0);
    const pathLine = status.stdout.split('\n').find((line) => line.includes('lock file:'));
    expect(pathLine).toContain(`/tmp/pels-test-lock.${process.getuid?.()}.json`);
    expect(pathLine).not.toContain(repoRoot);
  });

  it('lets a nested invocation inside the same process tree pass straight through', () => {
    // The nested wrapper gets a 200 ms timeout: without re-entrancy it would
    // block on the lock its own parent holds and exit 75.
    const result = runWrapper([
      '--label', 'spec:outer', '--',
      process.execPath, wrapper, '--label', 'spec:inner', '--timeout-ms', '200', '--',
      process.execPath, '-e', 'process.stdout.write("inner ran")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('inner ran');
    expect(result.stderr).not.toContain('waiting for the machine-wide test lock');
  });

  it('does not pass through when the inherited token no longer owns the lock', () => {
    writeHolder({ token: 'someone-else' });

    const result = runWrapper(
      ['--label', 'spec:stray', '--timeout-ms', '300', '--', process.execPath, '-e', 'process.stdout.write("nope")'],
      { PELS_TEST_LOCK_OWNER: 'holder-token' },
    );

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('nope');
  });

  it('does not pass through when the process that owned the inherited token is gone', () => {
    writeHolder({ pid: deadPid(), label: 'dead:ancestor' });
    ageLockFile(30_000);

    const result = runWrapper(
      ['--label', 'spec:orphan', '--timeout-ms', '2000', '--', process.execPath, '-e', 'process.stdout.write("ran")'],
      { PELS_TEST_LOCK_OWNER: 'holder-token' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('taking over dead:ancestor');
  });

  it('takes over a lock whose holder process is gone', () => {
    writeHolder({ pid: deadPid(), label: 'crashed:run' });
    ageLockFile(30_000);

    const result = runWrapper([
      '--label', 'spec:takeover', '--timeout-ms', '2000', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran');
    expect(result.stderr).toContain('taking over crashed:run');
  });

  it('leaves a just-published record alone even when its pid looks dead', () => {
    // A read that straddles a release and re-acquire can pair an old dead pid
    // with the new record's mtime; one heartbeat of age disambiguates it.
    writeHolder({ pid: deadPid(), label: 'fresh:record' });

    const result = runWrapper([
      '--label', 'spec:patient', '--timeout-ms', '300', '--',
      process.execPath, '-e', 'process.stdout.write("stole it")',
    ]);

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('stole it');
  });

  it('times out rather than spinning when the lock can be neither read nor created', () => {
    // A dangling symlink reads as ENOENT ("free") but blocks link() with EEXIST,
    // so the acquire loop retries forever unless it checks its deadline on every
    // iteration -- not just on the branch where a live holder is in the way.
    fs.symlinkSync(path.join(lockDir, 'nowhere.json'), lockFile);

    const result = runWrapper([
      '--label', 'spec:spin', '--timeout-ms', '400', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('ran');
    expect(result.stderr).toContain('timed out');
  });

  it('takes over a lock whose heartbeat stopped, even though the pid answers', () => {
    // The pid-reuse case: the recorded pid is alive (it is this process) but it
    // is not the original holder, so it never refreshed the heartbeat.
    writeHolder({ label: 'reused:pid' });
    ageLockFile(5 * 60 * 1000);

    const result = runWrapper([
      '--label', 'spec:takeover', '--timeout-ms', '2000', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('taking over reused:pid');
  });

  it('takes over an unreadable record only once it is past the grace window', () => {
    fs.writeFileSync(lockFile, 'not json at all');

    const fresh = runWrapper([
      '--label', 'spec:takeover', '--timeout-ms', '300', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);
    expect(fresh.status).toBe(75);

    ageLockFile(5 * 60 * 1000);
    const stale = runWrapper([
      '--label', 'spec:takeover', '--timeout-ms', '2000', '--',
      process.execPath, '-e', 'process.stdout.write("ran")',
    ]);

    expect(stale.status).toBe(0);
    expect(stale.stdout).toContain('ran');
    expect(stale.stderr).toContain('an unreadable lock record');
  });

  it('never deletes a lock record it does not own', () => {
    // Mimics a holder whose lock was taken over mid-run: on exit it must leave
    // the new holder's record alone rather than releasing on its behalf.
    const result = runWrapper([
      '--label', 'spec:overtaken', '--', process.execPath, '-e',
      'require(\'fs\').writeFileSync(process.env.PELS_TEST_LOCK_FILE, JSON.stringify('
      + '{ token: \'newer-owner\', pid: process.pid, label: \'newer\', cwd: \'/x\', command: \'y\','
      + ' startedAtMs: Date.now() }))',
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token).toBe('newer-owner');
  });

  it('releases a stuck record on demand, naming the pid to stop first', () => {
    writeHolder({ label: 'orphaned:run' });

    const result = runWrapper(['--release']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('releasing the lock held by orphaned:run');
    expect(result.stdout).toContain(`kill ${process.pid}`);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('is a no-op in CI', () => {
    writeHolder();

    const result = runWrapper(
      ['--label', 'spec:ci', '--timeout-ms', '200', '--', process.execPath, '-e', 'process.stdout.write("ran")'],
      { CI: 'true' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran');
    // The live holder's record is left exactly as it was: not waited on, not stolen.
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token).toBe('holder-token');
  });

  it('is bypassed by PELS_TEST_LOCK=0', () => {
    writeHolder();

    const result = runWrapper(
      ['--label', 'spec:bypass', '--timeout-ms', '200', '--', process.execPath, '-e', 'process.stdout.write("ran")'],
      { PELS_TEST_LOCK: '0' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran');
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token).toBe('holder-token');
  });

  it('still locks in CI when PELS_TEST_LOCK=1 forces it', () => {
    writeHolder();

    const result = runWrapper(
      ['--label', 'spec:forced', '--timeout-ms', '200', '--', process.execPath, '-e', 'process.stdout.write("nope")'],
      { CI: 'true', PELS_TEST_LOCK: '1' },
    );

    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('nope');
  });

  it('rejects a malformed timeout instead of quietly running unlocked', () => {
    const result = runWrapper(
      ['--label', 'spec:badtimeout', '--', process.execPath, '-e', 'process.stdout.write("ran")'],
      { PELS_TEST_LOCK_TIMEOUT_MS: '30m' },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('ran');
    expect(result.stderr).toContain('invalid test-lock timeout');
    expect(result.stderr).not.toContain('UNLOCKED');
  });

  it('runs unlocked, loudly, when the lock file itself cannot be used', () => {
    const blocked = path.join(lockDir, 'a-regular-file');
    fs.writeFileSync(blocked, 'not a directory');

    const result = runWrapper(
      ['--label', 'spec:failopen', '--', process.execPath, '-e', 'process.stdout.write("ran anyway")'],
      { PELS_TEST_LOCK_FILE: path.join(blocked, 'lock.json') },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran anyway');
    expect(result.stderr).toContain('running UNLOCKED');
  });
});
