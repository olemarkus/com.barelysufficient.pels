import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// e2e lane: nothing internal mocked; driven through a real external seam (Homey
// SDK boundary or a registered Flow card) and observed through that seam plus
// structured logs. These drive detached poll -> plan -> execute -> SDK-write
// chains, so they get a wider timeout than the fast lanes.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...sharedTest,
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: { enabled: false },
  },
});
