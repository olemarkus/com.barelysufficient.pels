// Shared test utilities for app instance cleanup
// Use explicit .ts extension to avoid resolving app.json instead of app.ts.
// Static import goes through Vitest's esbuild transform, which handles `export =`.
import MyApp from '../../app.ts';
import { mockHomeyInstance } from '../mocks/homey';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

let appInstances: any[] = [];

type CreateAppOptions = {
  preserveStartupRestoreStabilization?: boolean;
  /**
   * Leave the home with NO meter measurement, so `PowerMeasurementGate` keeps
   * the plan-build gate shut. Only for suites that exercise the gate itself.
   *
   * The default seeds one, because a whole-home meter is a documented PELS
   * prerequisite (`docs/getting-started.md`) — a booted app that has never seen
   * a reading is a startup instant, not a steady state, and a suite that leaves
   * it that way is asserting against a home PELS does not claim to serve.
   */
  withoutPowerMeasurement?: boolean;
};

// A real, unremarkable reading: the house drawing nothing leaves full headroom,
// so seeding it opens the gate without steering any capacity decision. Suites
// that care about the total report their own over the top.
const SEEDED_TOTAL_POWER_KW = 0;

/**
 * Create an app instance and track it for cleanup.
 * Call cleanupApps() in afterEach to properly stop all intervals.
 */
export function createApp(options: CreateAppOptions = {}): any {
  // Access private lifecycle members through an untyped view: this test seam
  // intentionally reaches into `initPlanEngine`/`planEngine` to suppress the
  // startup restore-stabilization window, which the public API does not expose.
  const app = new MyApp() as any;
  if (!options.preserveStartupRestoreStabilization) {
    const originalInitPlanEngine = app.initPlanEngine.bind(app);
    app.initPlanEngine = (...args: unknown[]) => {
      const result = originalInitPlanEngine(...args);
      app.planEngine?.clearStartupRestoreStabilization?.();
      return result;
    };
  }
  if (!options.withoutPowerMeasurement) {
    // Seed at guard construction, not after `onInit`: rebuilds that run DURING
    // startup (the price-delta-on-startup path) would otherwise still find the
    // build gate shut. Same private-member seam as the plan-engine wrap above.
    const originalInitCapacityGuard = app.initCapacityGuard.bind(app);
    app.initCapacityGuard = (...args: unknown[]) => {
      const result = originalInitCapacityGuard(...args);
      // Guard only, deliberately: the tracker keeps whatever the suite sets, so
      // seeding a measurement does not also hand every test a FRESH sample and
      // silently rewrite its headroom. Production stamps both together
      // (`recordPowerSampleForApp`), so this leaves the harness in a state real
      // ingest cannot produce — total present, never sampled, reading as
      // `stale_hold`. Tracked in TODO.md; see the tests that assert stale-hold
      // via an absent timestamp rather than an old one.
      app.capacityGuard?.reportTotalPower(SEEDED_TOTAL_POWER_KW);
      return result;
    };
  }
  appInstances.push(app);
  return app;
}

export function getLatestTargetSnapshotForTests(): TargetDeviceSnapshot[] {
  const app = mockHomeyInstance.app as { latestTargetSnapshot?: unknown } | null;
  return Array.isArray(app?.latestTargetSnapshot) ? app.latestTargetSnapshot as TargetDeviceSnapshot[] : [];
}

/**
 * Clean up all tracked app instances by calling onUninit().
 * Should be called in afterEach().
 */
export async function cleanupApps(): Promise<void> {
  for (const app of appInstances) {
    if (app && typeof app.onUninit === 'function') {
      try {
        await app.onUninit();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  appInstances = [];
  mockHomeyInstance.app = null;
}
