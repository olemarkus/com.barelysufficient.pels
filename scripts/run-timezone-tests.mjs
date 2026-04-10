import { spawnSync } from 'node:child_process';

const nodeProcess = globalThis.process;

const TIME_ZONES = Object.freeze([
  'UTC',
  'America/Los_Angeles',
  'Asia/Tokyo',
]);

const TEST_FILES = Object.freeze([
  'test/prices.test.ts',
  'test/norgesprisPriceService.test.ts',
]);

for (const timeZone of TIME_ZONES) {
  const args = [
    './node_modules/.bin/vitest',
    'run',
    '--config',
    'vitest.config.fast.ts',
    '--reporter=verbose',
    ...TEST_FILES,
  ];

  nodeProcess.stdout.write(`\nRunning timezone regression suite with TZ=${timeZone}\n`);
  const result = spawnSync(nodeProcess.execPath, args, {
    stdio: 'inherit',
    env: {
      ...nodeProcess.env,
      TZ: timeZone,
    },
  });

  if (result.status !== 0) {
    nodeProcess.exit(result.status ?? 1);
  }
}
