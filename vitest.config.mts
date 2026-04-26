import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'homey', replacement: resolve(configDir, 'test/mocks/homey.ts') },
      {
        find: '../../packages/contracts/src/targetCapabilities',
        replacement: resolve(configDir, 'test/mocks/contracts-targetCapabilities.ts'),
      },
      { find: 'echarts/core.js', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/core', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/charts.js', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/charts', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/components.js', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/components', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/renderers.js', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      { find: 'echarts/renderers', replacement: resolve(configDir, 'test/mocks/echarts-subpath-shim.ts') },
      {
        find: /^\.\/planReasonSemanticsCore\.js$/,
        replacement: resolve(configDir, 'packages/shared-domain/src/planReasonSemanticsCore.ts'),
      },
      {
        find: /^\.\/planReasonComparable\.js$/,
        replacement: resolve(configDir, 'packages/shared-domain/src/planReasonComparable.ts'),
      },
      {
        find: /^\.\/planReasonFormatting\.js$/,
        replacement: resolve(configDir, 'packages/shared-domain/src/planReasonFormatting.ts'),
      },
      {
        find: /^\.\/planReasonParsing\.js$/,
        replacement: resolve(configDir, 'packages/shared-domain/src/planReasonParsing.ts'),
      },
    ],
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
