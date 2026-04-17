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
      './planReasonSemanticsCore.js': resolve(__dirname, 'packages/shared-domain/src/planReasonSemanticsCore.ts'),
      './planReasonComparable.js': resolve(__dirname, 'packages/shared-domain/src/planReasonComparable.ts'),
      './planReasonFormatting.js': resolve(__dirname, 'packages/shared-domain/src/planReasonFormatting.ts'),
      './planReasonParsing.js': resolve(__dirname, 'packages/shared-domain/src/planReasonParsing.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/settings-ui.test.ts',
      'test/planPriceWidgetBrowser.test.ts',
      'test/**/*.perf.test.ts',
    ],
    setupFiles: ['test/setup.ts'],
    clearMocks: true,
    testTimeout: 10_000,
    pool: 'forks',
    maxWorkers: 1,
    execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
    silent: true,
    coverage: {
      enabled: false,
    },
  },
});
