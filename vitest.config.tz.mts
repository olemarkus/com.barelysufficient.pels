import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Timezone lane: the DST-sensitive suites, driven by scripts/run-timezone-tests.mjs
// across several TZ values. Suites that need a specific host zone gate themselves
// with `process.env.TZ === 'Europe/Oslo'` skips.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...sharedTest,
    include: [
      'test/tz/**/*.test.ts',
      'test/integration/prices.test.ts',
      'test/integration/norgesprisPriceService.test.ts',
    ],
    testTimeout: 10_000,
    coverage: { enabled: false },
  },
});
