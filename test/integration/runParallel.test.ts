import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runBounded } from '../../scripts/lib/run-parallel.mjs';

const waitForFileContent = async (filePath: string, expected: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
};

describe('bounded command runner', () => {
  it('runs no more than two child commands at once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-run-bounded-'));
    const eventPath = path.join(dir, 'events.log');
    const childScript = `
      const fs = require('node:fs');
      const [eventPath, label] = process.argv.slice(1);
      fs.appendFileSync(eventPath, label + ':start\\n');
      setTimeout(() => fs.appendFileSync(eventPath, label + ':end\\n'), 80);
    `;
    const commands = Array.from({ length: 4 }, (_, index) => ({
      label: `child-${index}`,
      command: process.execPath,
      args: ['-e', childScript, eventPath, String(index)],
    }));

    try {
      await runBounded(commands, 2);
      const events = fs.readFileSync(eventPath, 'utf8').trim().split('\n');
      let active = 0;
      let peak = 0;
      for (const event of events) {
        active += event.endsWith(':start') ? 1 : -1;
        peak = Math.max(peak, active);
      }
      expect(peak).toBe(2);
      expect(active).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid concurrency limits', async () => {
    await expect(runBounded([], 0)).rejects.toThrow('maxConcurrency must be a positive integer');
  });

  it('forwards cancellation to active command process groups', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-run-cancel-'));
    const eventPath = path.join(dir, 'events.log');
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../scripts/lib/run-parallel.mjs')).href;
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
    const runnerScript = `
      import { runBounded } from ${JSON.stringify(moduleUrl)};
      const [eventPath, childScript] = process.argv.slice(1);
      await runBounded([{
        label: 'cancel',
        command: process.execPath,
        args: ['-e', childScript, eventPath],
      }], 1);
    `;
    const runner = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      runnerScript,
      eventPath,
      childScript,
    ], { stdio: 'ignore' });

    try {
      await waitForFileContent(eventPath, 'child:start');
      runner.kill('SIGTERM');
      const runnerExit = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('runner did not exit after SIGTERM')), 5_000);
        runner.once('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(runnerExit).toBe(143);
      await waitForFileContent(eventPath, 'child:terminated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not intercept cancellation when imported without active children', async () => {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../scripts/lib/run-parallel.mjs')).href;
    const runner = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(moduleUrl)}); console.log('ready'); setInterval(() => {}, 1_000);`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    await new Promise<void>((resolve) => runner.stdout.once('data', () => resolve()));
    runner.kill('SIGTERM');
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('idle importer did not exit after SIGTERM')), 5_000);
        runner.once('close', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );

    expect(result).toEqual({ code: null, signal: 'SIGTERM' });
  });
});
