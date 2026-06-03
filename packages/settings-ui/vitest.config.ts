import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'echarts/core.js': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/core': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts.js': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/components.js': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/components': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers.js': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers': resolve(__dirname, '../../test/mocks/echarts-subpath-shim.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/settings-ui.test.ts'],
    setupFiles: ['test/setup.ts'],
    clearMocks: true,
    // The heavier settings-UI tests `boot()` the full UI behind a per-test
    // `vi.resetModules()`, so each one re-imports the whole boot module graph
    // and re-registers Material Web custom elements. That cold boot is ~1s when
    // uncontended, but the suite is single-threaded (`maxWorkers: 1`) and shares
    // a CI runner with the other jobs, so under CPU contention a boot can be
    // starved well past 10s and the wait-for-render assertions time out — a
    // load-induced flake, not a logic bug (the failures observed are always
    // `Test timed out`, never assertion errors). Give the scheduler the same
    // headroom the sibling layout config already uses.
    testTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    silent: true,
  },
});
