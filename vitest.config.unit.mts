import { defineConfig } from 'vitest/config';
import { sharedAlias, sharedTest } from './vitest.shared.mts';

// Unit lane: one pure function/method per spec, no I/O. jsdom widget-render
// specs live here too and self-declare their environment via a per-file
// `// @vitest-environment jsdom` pragma.
//
// Unit specs reuse workers across files instead of spawning one per file,
// which takes the lane from 43 s to about 10 s. The first setup file clears the
// module registry, so each file still gets fresh module instances.
export const unitTest = {
  ...sharedTest,
  setupFiles: ['test/utils/freshModuleRegistry.ts', ...sharedTest.setupFiles],
  include: ['test/unit/**/*.test.ts'],
  testTimeout: 10_000,
  isolate: false,
};

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    ...unitTest,
    coverage: { enabled: false },
  },
});
