import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const configuredWorkers = Number(process.env.PELS_TEST_WORKERS ?? '2');
if (!Number.isInteger(configuredWorkers) || configuredWorkers < 1 || configuredWorkers > 2) {
  throw new Error('PELS_TEST_WORKERS must be 1 or 2');
}

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
    environment: 'node',
    include: ['test/settings-ui.test.ts'],
    clearMocks: true,
    testTimeout: 30_000,
    pool: 'forks',
    maxWorkers: configuredWorkers,
  },
});
