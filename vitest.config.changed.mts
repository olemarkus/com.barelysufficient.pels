import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Local hook lane: discover related tests across every runtime taxonomy tier
// without starting four independent Vitest coordinators.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...sharedTest,
    include: ['test/{unit,integration,e2e,tz}/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: { enabled: false },
  },
});
