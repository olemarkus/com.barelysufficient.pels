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
      './planReasonSemanticsCore.js': resolve(configDir, 'packages/shared-domain/src/planReasonSemanticsCore.ts'),
      './planReasonComparable.js': resolve(configDir, 'packages/shared-domain/src/planReasonComparable.ts'),
      './planReasonFormatting.js': resolve(configDir, 'packages/shared-domain/src/planReasonFormatting.ts'),
      './planReasonParsing.js': resolve(configDir, 'packages/shared-domain/src/planReasonParsing.ts'),
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
