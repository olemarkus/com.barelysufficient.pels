import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));
const at = (relativePath: string): string => resolve(configDir, relativePath);

// Module aliases shared by every runtime test lane: the Homey SDK mock, the
// contracts target-capabilities mock, and the echarts subpath shims.
export const sharedAlias = [
  { find: 'homey', replacement: at('test/mocks/homey.ts') },
  {
    find: '../../packages/contracts/src/targetCapabilities',
    replacement: at('test/mocks/contracts-targetCapabilities.ts'),
  },
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
// via a `// @vitest-environment jsdom` pragma. `pool: 'forks'` with the default
// (CPU-based) worker count runs files in isolated processes, in parallel.
export const sharedTest = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['test/setup.ts'],
  clearMocks: true,
  pool: 'forks' as const,
  execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
  silent: true,
};
