import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runWithValidationLock } from '../../scripts/with-validation-lock.mjs';

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
    });
    await waitForFileContent(eventPath, 'first:start');
    const second = runWithValidationLock({
      label: 'second',
      command: process.execPath,
      args: ['-e', childScript, eventPath, 'second', '0'],
      env,
      lockPath,
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
    });

    expect(code).toBe(0);
  });

  it('forwards cancellation and promptly releases the lock', async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'validation.lock');
    const eventPath = path.join(dir, 'events.log');
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
      const [lockPath, eventPath, childScript] = process.argv.slice(1);
      const code = await runWithValidationLock({
        label: 'cancel',
        command: process.execPath,
        args: ['-e', childScript, eventPath],
        env: { PATH: process.env.PATH ?? '', CI: '1' },
        lockPath,
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
    await expect(runWithValidationLock({
      label: 'reacquire',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH ?? '' },
      lockPath,
      timeoutSeconds: 1,
    })).resolves.toBe(0);
  });
});
