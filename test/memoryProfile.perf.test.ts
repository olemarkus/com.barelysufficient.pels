/**
 * @vitest-environment node
 *
 * Memory profile: measures RSS cost of loading each major module.
 * Run with:  npm run test:perf -- --testPathPatterns='memoryProfile'
 */

const MB = 1024 * 1024;

const hasGc = typeof (globalThis as unknown as { gc?: unknown }).gc === 'function';

const forceGc = (): void => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
};

const rss = (): number => {
  forceGc();
  return process.memoryUsage().rss;
};

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

const profileRequire = (label: string, modulePath: string, baseline: number): number => {
  const before = rss();
  require(modulePath);
  const after = rss();
  const delta = (after - before) / MB;
  const total = (after - baseline) / MB;
  log(`  ${label.padEnd(50)} delta=${delta.toFixed(1).padStart(6)} MB   cumulative=${total.toFixed(1).padStart(6)} MB`);
  return after;
};

describe('memory profile', () => {
  const profileIt = hasGc ? it : it.skip;

  profileIt('should profile RSS cost of each major module', () => {
    const baseline = rss();
    log(`\n[Memory Profile] baseline RSS=${(baseline / MB).toFixed(1)} MB\n`);

    // Core utilities
    profileRequire('utils/perfCounters', '../lib/utils/perfCounters', baseline);
    profileRequire('utils/runtimeTrace', '../lib/utils/runtimeTrace', baseline);
    profileRequire('utils/planRebuildTrace', '../lib/utils/planRebuildTrace', baseline);
    profileRequire('utils/cpuSpikeMonitor', '../lib/utils/cpuSpikeMonitor', baseline);

    // Daily budget
    profileRequire('dailyBudget/dailyBudgetMath', '../lib/dailyBudget/dailyBudgetMath', baseline);
    profileRequire('dailyBudget/dailyBudgetState', '../lib/dailyBudget/dailyBudgetState', baseline);
    profileRequire('dailyBudget/dailyBudgetPlanCore', '../lib/dailyBudget/dailyBudgetPlanCore', baseline);
    profileRequire('dailyBudget/dailyBudgetService', '../lib/dailyBudget/dailyBudgetService', baseline);
    profileRequire('dailyBudget/dailyBudgetManager', '../lib/dailyBudget/dailyBudgetManager', baseline);

    // Plan & Price
    profileRequire('plan/planService', '../lib/plan/planService', baseline);
    profileRequire('price/priceService', '../lib/price/priceService', baseline);

    // Diagnostics
    profileRequire('diagnostics/deviceDiagnosticsService', '../lib/diagnostics/deviceDiagnosticsService', baseline);

    // Power/Device — broken down
    profileRequire('power/estimate', '../lib/power/estimate', baseline);
    profileRequire('device/managerHelpers', '../lib/device/managerHelpers', baseline);
    profileRequire('device/managerParse', '../lib/device/managerParse', baseline);
    profileRequire('device/managerControl', '../lib/device/managerControl', baseline);
    profileRequire('device/managerFetch', '../lib/device/managerFetch', baseline);
    profileRequire('device/managerEnergy', '../lib/device/managerEnergy', baseline);
    profileRequire('device/managerRuntime', '../lib/device/managerRuntime', baseline);
    profileRequire('device/managerHomeyApi', '../lib/device/managerHomeyApi', baseline);
    profileRequire('device/managerRealtimeHandlers', '../lib/device/managerRealtimeHandlers', baseline);
    profileRequire('device/managerRealtimeSupport', '../lib/device/managerRealtimeSupport', baseline);
    profileRequire('device/load', '../lib/device/load', baseline);
    profileRequire('power/capacityGuard', '../lib/power/capacityGuard', baseline);
    profileRequire('power/tracker', '../lib/power/tracker', baseline);
    profileRequire('device/manager', '../lib/device/manager', baseline);

    // App-level
    profileRequire('app/appResourceWarningHelpers', '../lib/app/appResourceWarningHelpers', baseline);
    profileRequire('app/perfLogging', '../lib/app/perfLogging', baseline);
    const final = rss();
    log(`\n[Memory Profile] final RSS=${(final / MB).toFixed(1)} MB  total delta=${((final - baseline) / MB).toFixed(1)} MB\n`);

    expect(true).toBe(true);
  }, 30_000);
});
