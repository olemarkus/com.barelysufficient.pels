/**
 * @jest-environment node
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

    // Core — broken down
    profileRequire('core/powerEstimate', '../lib/core/powerEstimate', baseline);
    profileRequire('core/powerMeasurement', '../lib/core/powerMeasurement', baseline);
    profileRequire('core/deviceManagerHelpers', '../lib/core/deviceManagerHelpers', baseline);
    profileRequire('core/deviceManagerParse', '../lib/core/deviceManagerParse', baseline);
    profileRequire('core/deviceManagerControl', '../lib/core/deviceManagerControl', baseline);
    profileRequire('core/deviceManagerFetch', '../lib/core/deviceManagerFetch', baseline);
    profileRequire('core/deviceManagerEnergy', '../lib/core/deviceManagerEnergy', baseline);
    profileRequire('core/deviceManagerRuntime', '../lib/core/deviceManagerRuntime', baseline);
    profileRequire('core/deviceManagerHomeyApi', '../lib/core/deviceManagerHomeyApi', baseline);
    profileRequire('core/deviceManagerRealtimeHandlers', '../lib/core/deviceManagerRealtimeHandlers', baseline);
    profileRequire('core/deviceManagerRealtimeSupport', '../lib/core/deviceManagerRealtimeSupport', baseline);
    profileRequire('core/deviceLoad', '../lib/core/deviceLoad', baseline);
    profileRequire('core/capacityGuard', '../lib/core/capacityGuard', baseline);
    profileRequire('core/powerTracker', '../lib/core/powerTracker', baseline);
    profileRequire('core/deviceManager', '../lib/core/deviceManager', baseline);

    // Insights / charts
    profileRequire('insights/planPriceImageTheme', '../lib/insights/planPriceImageTheme', baseline);
    profileRequire('insights/planPriceImageEcharts', '../lib/insights/planPriceImageEcharts', baseline);
    profileRequire('insights/planPriceImage', '../lib/insights/planPriceImage', baseline);

    // App-level
    profileRequire('app/appResourceWarningHelpers', '../lib/app/appResourceWarningHelpers', baseline);
    profileRequire('app/perfLogging', '../lib/app/perfLogging', baseline);

    // External modules
    profileRequire('@napi-rs/canvas', '@napi-rs/canvas', baseline);
    const final = rss();
    log(`\n[Memory Profile] final RSS=${(final / MB).toFixed(1)} MB  total delta=${((final - baseline) / MB).toFixed(1)} MB\n`);

    expect(true).toBe(true);
  }, 30_000);
});
