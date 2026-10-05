import { defineConfig } from 'vitest/config';
import { unitTest } from './vitest.config.unit.mts';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Local hook lane: discover related tests across every runtime taxonomy tier
// in one Vitest coordinator. Unit specs keep their lane's shared module
// registry; the other tiers stay isolated per file.
export default defineConfig({
  test: {
    // Reporter options are read from the root config, not from projects.
    maxWorkers: sharedTest.maxWorkers,
    silent: sharedTest.silent,
    coverage: { enabled: false },
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: { ...unitTest, name: 'unit' },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          ...sharedTest,
          name: 'runtime',
          include: ['test/{integration,e2e,tz}/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
