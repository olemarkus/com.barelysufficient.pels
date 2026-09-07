// Shared test utilities for app instance cleanup
// Use explicit .ts extension to avoid resolving app.json instead of app.ts.
// Static import goes through Vitest's esbuild transform, which handles `export =`.
import MyApp from '../../app.ts';
import { mockHomeyInstance } from '../mocks/homey';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { createTrackerStore, type TrackerStore } from '../../lib/power/trackerStore';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { openUserdataStores } from '../../setup/userdataStores';

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
  /**
   * Where the userdata database lives for this app instance. Defaults to one
   * file per spec FILE, deleted by `cleanupApps` after every test — the
   * `mockHomeyInstance.settings` analogue: two apps booted inside one test
   * (a restart) share it, and the next test starts empty.
   */
  userdataDatabase?: string;
};

let testUserdataDir: string | undefined;
const testUserdataDatabase = (): string => {
  testUserdataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pels-userdata-'));
  return path.join(testUserdataDir, 'pels.sqlite');
};
/** Drop the spec file's database so the next test boots on an empty store. */
const removeTestUserdataDatabase = (): void => {
  if (testUserdataDir === undefined) return;
  for (const sidecar of ['', '-wal', '-shm']) {
    fs.rmSync(path.join(testUserdataDir, `pels.sqlite${sidecar}`), { force: true });
  }
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
  // The database is opened at the first boot step, after construction, so
  // this override lands before anything reaches the file the production path
  // would open.
  app['openUserdataStores'] = () => openUserdataStores(
    openUserdataDatabase(options.userdataDatabase ?? testUserdataDatabase()),
  );
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
      // BOTH halves of the latch, exactly as production ingest stamps them
      // (`recordPowerSampleForApp`): the reading resolver requires a stamped
      // sample behind every build, so the old value-only seed — a state real
      // ingest cannot produce — now fails loud instead of reading as held.
      // With a 0 kW seed the fresh sample steers nothing: headroom is full,
      // and suites that care about the total or its age stamp their own.
      app.powerTracker = {
        ...app.powerTracker,
        lastPowerW: SEEDED_TOTAL_POWER_KW * 1000,
        lastTimestamp: Date.now(),
      };
    };
  }
  appInstances.push(app);
  return app;
}

/**
 * Seed the tracker the app under test will hydrate at boot: the store's rows
 * in the database `createApp` opens, written before `onInit` reads them.
 */
export function seedStoredPowerTrackerForTests(state: PowerTrackerState, homeId: string = 'main'): void {
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    createTrackerStore(database).replace(homeId, state);
  } finally {
    database.close();
  }
}

/**
 * The tracker as the app under test has persisted it — the store's rows, not
 * a settings key. `null` while nothing has been persisted for the home.
 */
export function getStoredPowerTrackerForTests(homeId: string = 'main'): PowerTrackerState | null {
  const app = mockHomeyInstance.app as { getTrackerStore?: () => TrackerStore } | null;
  try {
    const store = app?.getTrackerStore?.();
    if (store !== undefined) return store.load(homeId);
  } catch {
    // The app has torn down (its database is closed): read the file it wrote.
  }
  if (testUserdataDir === undefined) return null;
  const database = openUserdataDatabase(testUserdataDatabase());
  try {
    return createTrackerStore(database).load(homeId);
  } finally {
    database.close();
  }
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
  removeTestUserdataDatabase();
}
