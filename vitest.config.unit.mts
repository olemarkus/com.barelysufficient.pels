import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Unit lane: one pure function/method per spec, no I/O. jsdom widget-render
// specs live here too and self-declare their environment via a per-file
// `// @vitest-environment jsdom` pragma.
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...sharedTest,
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: { enabled: false },
  },
});
