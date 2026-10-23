import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runWithValidationLock, validationLockPath } from '../../scripts/with-validation-lock.mjs';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-validation-lock-'));
  tempDirs.push(dir);
  return dir;
};

const waitForFileContent = async (filePath: string, expected: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
};

describe('machine-wide validation lock', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserves the test lane for test entrypoints and the checks lane for static checks', () => {
    const packagePaths = [
      path.resolve(__dirname, '../../package.json'),
      path.resolve(__dirname, '../../packages/settings-ui/package.json'),
    ];

    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        scripts: Record<string, string>;
        'lint-staged'?: Record<string, string[]>;
      };
      const lockedScripts = Object.entries(packageJson.scripts)
        .filter(([, command]) => command.includes('with-validation-lock.mjs'));

      expect(lockedScripts.length).toBeGreaterThan(0);
      for (const [name, command] of lockedScripts) {
        if (command.includes('with-validation-lock.mjs --checks ')) {
          expect(name).toBe('ci:checks');
        } else {
          expect(name).toMatch(/(?:^|:)test(?::|$)/u);
        }
      }

      for (const commands of Object.values(packageJson['lint-staged'] ?? {})) {
        // Related tests run at push, so ordinary commits never take the test lock.
        expect(commands.join('\n')).not.toMatch(/vitest|pre-commit-tests|with-validation-lock/u);
      }
    }

    for (const hook of ['pre-commit', 'pre-push']) {
      const hookScript = fs.readFileSync(path.resolve(__dirname, `../../.husky/${hook}`), 'utf8');
      expect(hookScript).not.toContain('with-validation-lock.mjs');
    }

    // The commit hook's lint and typecheck share the static-check lane only.
    const preCommit = fs.readFileSync(path.resolve(__dirname, '../../scripts/pre-commit-checks.mjs'), 'utf8');
    expect(preCommit).toMatch(/'scripts\/with-validation-lock\.mjs',\s*'--checks',\s*'pre-commit:lint-staged'/u);
  });

  it('keeps static checks and test runs on separate lock files', () => {
    expect(validationLockPath('checks')).not.toBe(validationLockPath('test'));
    expect(validationLockPath()).toBe(validationLockPath('test'));
  });

  it('parses the --checks flag on the command line', () => {
    const scriptPath = path.resolve(__dirname, '../../scripts/with-validation-lock.mjs');
    // The held marker skips the machine-wide checks lock, so this never queues
    // behind a real ci:checks run. A misparsed flag would fail with usage (2).
    const env = { PATH: process.env.PATH ?? '', CI: '1', PELS_CHECKS_LOCK_HELD: '1' };

    const ran = spawnSync(process.execPath, [
      scriptPath, '--checks', 'cli', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'ran',
    ], { env, encoding: 'utf8' });
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('ran');

    const missingLabel = spawnSync(process.execPath, [
      scriptPath, '--checks', '--', process.execPath, '-e', 'process.exit(0)',
    ], { env, encoding: 'utf8' });
    expect(missingLabel.status).toBe(2);
  });

  it('does not let a held checks lock skip the test lock', async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'validation.lock');
    const eventPath = path.join(dir, 'events.log');
    const childScript = `
      const fs = require('node:fs');
      const [eventPath, label, delay] = process.argv.slice(1);
      fs.appendFileSync(eventPath, label + ':start\\n');
      setTimeout(() => fs.appendFileSync(eventPath, label + ':end\\n'), Number(delay));
    `;
    const env = { PATH: process.env.PATH ?? '', CI: '1' };

    const first = runWithValidationLock({
      label: 'test-run',
      command: process.execPath,
      args: ['-e', childScript, eventPath, 'test-run', '120'],
      env,
      lockPath,
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });
    await waitForFileContent(eventPath, 'test-run:start');
    const second = runWithValidationLock({
      label: 'test-inside-checks',
      command: process.execPath,
      args: ['-e', childScript, eventPath, 'test-inside-checks', '0'],
      env: { ...env, PELS_CHECKS_LOCK_HELD: '1' },
      lockPath,
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(fs.readFileSync(eventPath, 'utf8').trim().split('\n')).toEqual([
      'test-run:start',
      'test-run:end',
      'test-inside-checks:start',
      'test-inside-checks:end',
    ]);
  });

  it('lets static checks nested under the checks lock reuse it', async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'checks.lock');
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../scripts/with-validation-lock.mjs')).href;
    // The command run under the lock starts its own checks-lane run on the same
    // lock file with the environment it inherited. Unless the held marker
    // reaches it, it waits on its parent and times out after a second with 75.
    const nestedScript = `
      const { runWithValidationLock } = await import(${JSON.stringify(moduleUrl)});
      process.exit(await runWithValidationLock({
        label: 'nested',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        lockPath: ${JSON.stringify(lockPath)},
        lane: 'checks',
        timeoutSeconds: 1,
        tmpRoot: ${JSON.stringify(path.join(makeTempDir(), 'tmp-root'))},
      }));
    `;

    await expect(runWithValidationLock({
      label: 'owner',
      command: process.execPath,
      args: ['--input-type=module', '-e', nestedScript],
      env: { PATH: process.env.PATH ?? '', CI: '1' },
      lockPath,
      lane: 'checks',
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    })).resolves.toBe(0);
  });

  it('serializes contenders that share a lock file', async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'validation.lock');
    const eventPath = path.join(dir, 'events.log');
    const childScript = `
      const fs = require('node:fs');
      const [eventPath, label, delay] = process.argv.slice(1);
      fs.appendFileSync(eventPath, label + ':start\\n');
      setTimeout(() => fs.appendFileSync(eventPath, label + ':end\\n'), Number(delay));
    `;
    const env = { PATH: process.env.PATH ?? '', CI: '1' };

    const first = runWithValidationLock({
      label: 'first',
      command: process.execPath,
      args: ['-e', childScript, eventPath, 'first', '120'],
      env,
      lockPath,
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });
    await waitForFileContent(eventPath, 'first:start');
    const second = runWithValidationLock({
      label: 'second',
      command: process.execPath,
      args: ['-e', childScript, eventPath, 'second', '0'],
      env,
      lockPath,
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(fs.readFileSync(eventPath, 'utf8').trim().split('\n')).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('lets nested validation reuse the owning lock on every platform', async () => {
    const code = await runWithValidationLock({
      label: 'nested',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {
        PATH: process.env.PATH ?? '',
        PELS_VALIDATION_LOCK_HELD: '1',
      },
      platform: 'darwin',
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });

    expect(code).toBe(0);
  });

  it('falls back to worker caps on an unsupported local platform', async () => {
    const code = await runWithValidationLock({
      label: 'unsupported',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH ?? '' },
      platform: 'darwin',
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    });

    expect(code).toBe(0);
  });

  it('runs the command with its own TMPDIR, keeps the caller\'s, and removes its own afterwards', async () => {
    const dir = makeTempDir();
    const tmpRoot = path.join(dir, 'tmp-root');
    const reportPath = path.join(dir, 'tmpdir.txt');
    const childScript = `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      fs.writeFileSync(process.argv[1], JSON.stringify([os.tmpdir(), process.env.PELS_CALLER_TMPDIR]));
      fs.mkdirSync(path.join(os.tmpdir(), 'leftover'));
    `;

    const code = await runWithValidationLock({
      label: 'tmpdir',
      command: process.execPath,
      args: ['-e', childScript, reportPath],
      env: { PATH: process.env.PATH ?? '', CI: '1' },
      lockPath: path.join(dir, 'validation.lock'),
      tmpRoot,
    });

    expect(code).toBe(0);
    const [runTmpDir, callerTmpDir] = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as [string, string];
    expect(path.dirname(runTmpDir)).toBe(tmpRoot);
    expect(callerTmpDir).toBe(os.tmpdir());
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('removes run directories whose wrapper is gone and keeps live ones', async () => {
    const dir = makeTempDir();
    const tmpRoot = path.join(dir, 'tmp-root');
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const orphaned = path.join(tmpRoot, `${exited.pid}-orphan`);
    const live = path.join(tmpRoot, `${process.pid}-live`);
    fs.mkdirSync(path.join(orphaned, 'ssr'), { recursive: true });
    fs.mkdirSync(live, { recursive: true });

    const code = await runWithValidationLock({
      label: 'sweep',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH ?? '' },
      platform: 'darwin',
      tmpRoot,
    });

    expect(code).toBe(0);
    expect(fs.readdirSync(tmpRoot)).toEqual([path.basename(live)]);
  });

  it('forwards cancellation and promptly releases the lock', async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'validation.lock');
    const eventPath = path.join(dir, 'events.log');
    const tmpRoot = path.join(dir, 'tmp-root');
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../scripts/with-validation-lock.mjs')).href;
    const childScript = `
      const fs = require('node:fs');
      const eventPath = process.argv[1];
      fs.appendFileSync(eventPath, 'child:start\\n');
      process.on('SIGTERM', () => {
        fs.appendFileSync(eventPath, 'child:terminated\\n');
        process.exit(0);
      });
      setInterval(() => {}, 1_000);
    `;
    const wrapperScript = `
      import { runWithValidationLock } from ${JSON.stringify(moduleUrl)};
      const [lockPath, eventPath, childScript, tmpRoot] = process.argv.slice(1);
      const code = await runWithValidationLock({
        label: 'cancel',
        command: process.execPath,
        args: ['-e', childScript, eventPath],
        env: { PATH: process.env.PATH ?? '', CI: '1' },
        lockPath,
        tmpRoot,
      });
      process.exit(code);
    `;
    const wrapper = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      wrapperScript,
      lockPath,
      eventPath,
      childScript,
      tmpRoot,
    ], { stdio: 'ignore' });

    await waitForFileContent(eventPath, 'child:start');
    wrapper.kill('SIGTERM');
    const wrapperExit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('wrapper did not exit after SIGTERM')), 5_000);
      wrapper.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(wrapperExit).toBe(143);
    await waitForFileContent(eventPath, 'child:terminated');
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    await expect(runWithValidationLock({
      label: 'reacquire',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH ?? '' },
      lockPath,
      timeoutSeconds: 1,
      tmpRoot: path.join(makeTempDir(), 'tmp-root'),
    })).resolves.toBe(0);
  });
});
