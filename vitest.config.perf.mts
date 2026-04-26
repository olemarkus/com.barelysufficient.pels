import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      homey: resolve(configDir, 'test/mocks/homey.ts'),
      '../../packages/contracts/src/targetCapabilities': resolve(
        configDir,
        'test/mocks/contracts-targetCapabilities.ts',
      ),
      'echarts/core.js': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/core': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts.js': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/charts': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/components.js': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/components': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers.js': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
      'echarts/renderers': resolve(configDir, 'test/mocks/echarts-subpath-shim.ts'),
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
    maxWorkers: 1,
    execArgv: ['--expose-gc'],
    reporter: 'verbose',
    coverage: {
      enabled: false,
    },
  },
});
