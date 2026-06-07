import { spawnSync } from 'node:child_process';

const nodeProcess = globalThis.process;

const TIME_ZONES = Object.freeze([
  'UTC',
  'America/Los_Angeles',
  'Asia/Tokyo',
  // Europe/Oslo gates the DST-formatting suites — `Date#getHours()`-style
  // local rendering only exercises the spring-forward / fall-back boundary
  // when the host TZ matches. Suites that need this gate themselves with
  // `process.env.TZ === 'Europe/Oslo'` skips.
  'Europe/Oslo',
]);

const TEST_FILES = Object.freeze([
  'test/integration/prices.test.ts',
  'test/integration/norgesprisPriceService.test.ts',
  'test/tz/powerTrackerDst.test.ts',
  'test/tz/formatCheapestUpcomingHourDst.test.ts',
]);

for (const timeZone of TIME_ZONES) {
  const args = [
    './node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.config.tz.mts',
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
