import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      homey: resolve(__dirname, 'test/mocks/homey.ts'),
      '../../packages/contracts/src/targetCapabilities': resolve(
        __dirname,
        'test/mocks/contracts-targetCapabilities.ts',
      ),
      'echarts/core.js': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/core': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts.js': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/components.js': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/components': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers.js': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers': resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.perf.test.ts'],
    setupFiles: ['test/setup.ts'],
    clearMocks: true,
    testTimeout: 60_000,
    pool: 'forks',
    maxForks: 1,
    forkOptions: {
      execArgv: ['--expose-gc'],
    },
    reporter: 'verbose',
    coverage: {
      enabled: false,
    },
  },
});
