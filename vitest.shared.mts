import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));
const at = (relativePath: string): string => resolve(configDir, relativePath);
const configuredWorkers = Number(process.env.PELS_TEST_WORKERS ?? '2');

if (!Number.isInteger(configuredWorkers) || configuredWorkers < 1 || configuredWorkers > 2) {
  throw new Error('PELS_TEST_WORKERS must be 1 or 2');
}

// Module aliases shared by every runtime test lane: the Homey SDK mock and the
// echarts subpath shims.
export const sharedAlias = [
  { find: 'homey', replacement: at('test/mocks/homey.ts') },
  { find: 'echarts/core.js', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/core', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/charts.js', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/charts', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/components.js', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/components', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/renderers.js', replacement: at('test/mocks/echarts-subpath-shim.ts') },
  { find: 'echarts/renderers', replacement: at('test/mocks/echarts-subpath-shim.ts') },
];

// Extra aliases the coverage lane needs so v8 instruments the shared-domain
// `.ts` sources behind the published `.js` shims (kept out of the fast lanes,
// which don't instrument).
export const coverageAlias = [
  {
    find: /^\.\/planReasonSemanticsCore\.js$/,
    replacement: at('packages/shared-domain/src/planReasonSemanticsCore.ts'),
  },
  {
    find: /^\.\/planReasonComparable\.js$/,
    replacement: at('packages/shared-domain/src/planReasonComparable.ts'),
  },
  {
    find: /^\.\/planReasonFormatting\.js$/,
    replacement: at('packages/shared-domain/src/planReasonFormatting.ts'),
  },
  {
    find: /^\.\/planReasonParsing\.js$/,
    replacement: at('packages/shared-domain/src/planReasonParsing.ts'),
  },
];

// Base test options every runtime lane shares. Each lane sets `include` and may
// override `testTimeout`. Environment defaults to node; jsdom specs self-declare
// via a `// @vitest-environment jsdom` pragma. Forks preserve process isolation
// while the explicit worker cap protects a shared development host.
export const sharedTest = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['test/setup.ts'],
  clearMocks: true,
  pool: 'forks' as const,
  maxWorkers: configuredWorkers,
  execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
  silent: true,
};
