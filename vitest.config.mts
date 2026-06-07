import { defineConfig } from 'vitest/config';
import { sharedAlias, coverageAlias, sharedTest } from './vitest.shared.mts';

// Coverage lane: runs every runtime tier (unit + integration + e2e) in one
// instrumented pass and enforces the 80% threshold. The fast per-tier lanes
// (vitest.config.{unit,integration,e2e}.mts) carry no coverage; this is the
// single place the gate lives. jsdom widget specs self-declare via a per-file
// pragma, so they run here too and count toward coverage.
export default defineConfig({
  resolve: { alias: [...sharedAlias, ...coverageAlias] },
  test: {
    ...sharedTest,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: [
        'app.ts',
        'api.ts',
        'lib/**/*.ts',
        'flowCards/**/*.ts',
        'drivers/**/*.ts',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
