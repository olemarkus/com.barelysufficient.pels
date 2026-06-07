import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Integration lane: one layer end-to-end, only the layer's outward seams
// (Homey SDK, price source, clock, persistence) mocked via shared helpers.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...sharedTest,
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: { enabled: false },
  },
});
