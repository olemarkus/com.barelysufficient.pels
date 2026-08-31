// Shared test utilities for app instance cleanup
// Use explicit .ts extension to avoid resolving app.json instead of app.ts.
// Static import goes through Vitest's esbuild transform, which handles `export =`.
import MyApp from '../../app.ts';
import { mockHomeyInstance } from '../mocks/homey';
import { MAIN_METER_AUTHORITY_MIGRATION_MARKER } from '../../setup/mainMeterAuthorityMigration';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

let appInstances: MyApp[] = [];

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
export function createApp(options: CreateAppOptions = {}): MyApp {
  // Protected lifecycle members are reached via element access — the typed
  // escape hatch, so a rename in the app still breaks this seam loudly. The
  // wrap suppresses the startup restore-stabilization window, which the
  // public API does not expose.
  const app = new MyApp();
  // App tests represent a MIGRATED install: the one-time meter-authority
  // migration already ran, so booting here never fetches the live energy
  // report or rewrites power_source under a test's fixture. The migration's
  // own suite (test/integration/mainMeterAuthorityMigration.test.ts) builds
  // unmigrated installs explicitly; a test that wants the boot-time migration
  // can unset this marker after createApp() and before onInit().
  if (mockHomeyInstance.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER) === null) {
    mockHomeyInstance.settings.set(MAIN_METER_AUTHORITY_MIGRATION_MARKER, true);
  }
  if (!options.preserveStartupRestoreStabilization) {
    const originalInitPlanEngine = app['initPlanEngine'].bind(app);
    app['initPlanEngine'] = () => {
      originalInitPlanEngine();
      app.planEngine?.clearStartupRestoreStabilization();
    };
  }
  if (!options.withoutPowerMeasurement) {
    // Seed at guard construction, not after `onInit`: rebuilds that run DURING
    // startup (the price-delta-on-startup path) would otherwise still find the
    // build gate shut. Same protected-member seam as the plan-engine wrap above.
    const originalInitCapacityGuard = app['initCapacityGuard'].bind(app);
    app['initCapacityGuard'] = () => {
      originalInitCapacityGuard();
      // The VALUE latch only, deliberately: `lastTimestamp` is left alone, so
      // seeding a measurement does not also hand every test a FRESH sample and
      // silently rewrite its headroom. Production stamps both together
      // (`recordPowerSampleForApp`), so this leaves the harness in a state real
      // ingest cannot produce — total present, never sampled, reading as
      // `stale_hold`. Tracked in TODO.md; see the tests that assert stale-hold
      // via an absent timestamp rather than an old one.
      app.powerTracker = { ...app.powerTracker, lastPowerW: SEEDED_TOTAL_POWER_KW * 1000 };
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
