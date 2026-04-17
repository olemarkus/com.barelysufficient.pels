import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      { find: 'homey', replacement: resolve(__dirname, 'test/mocks/homey.ts') },
      {
        find: '../../packages/contracts/src/targetCapabilities',
        replacement: resolve(__dirname, 'test/mocks/contracts-targetCapabilities.ts'),
      },
      { find: 'echarts/core.js', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/core', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/charts.js', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/charts', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/components.js', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/components', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/renderers.js', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/renderers', replacement: resolve(__dirname, 'test/mocks/echarts-subpath-shim.ts') },
      {
        find: /^\.\/planReasonSemanticsCore\.js$/,
        replacement: resolve(__dirname, 'packages/shared-domain/src/planReasonSemanticsCore.ts'),
      },
      {
        find: /^\.\/planReasonComparable\.js$/,
        replacement: resolve(__dirname, 'packages/shared-domain/src/planReasonComparable.ts'),
      },
      {
        find: /^\.\/planReasonFormatting\.js$/,
        replacement: resolve(__dirname, 'packages/shared-domain/src/planReasonFormatting.ts'),
      },
      {
        find: /^\.\/planReasonParsing\.js$/,
        replacement: resolve(__dirname, 'packages/shared-domain/src/planReasonParsing.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/planPriceWidgetBrowser.test.ts'],
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
