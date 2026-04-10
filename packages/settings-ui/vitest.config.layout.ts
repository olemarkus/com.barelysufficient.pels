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
    environment: 'node',
    include: ['test/settings-ui.test.ts'],
    clearMocks: true,
    testTimeout: 30_000,
  },
});
